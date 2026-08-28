// Sidecar daemons: small helper services that should FOLLOW `dsh web`
// startup instead of needing OS-level autostart (user ruling: 跟随 dsh 启动，
// 而不是开机自启). Config lives in ~/.dsh/extension-manager/sidecars.json:
//
//   { "sidecars": [ { "id": "sodamem", "exe": "...sodamem.exe",
//                     "args": ["daemon","ensure","--api-url","http://127.0.0.1:8000"],
//                     "enabled": true } ] }
//
// Every enabled entry is spawned DETACHED at extension-manager activation
// (fire-and-forget, never blocking boot — stability discipline). Sidecar
// commands MUST be idempotent "ensure"-style: the sodamem daemon ensure
// health-checks first and exits happy when the service already answers, so
// even duplicate activations are harmless. Children survive `dsh web` exit
// (detached + unref) by design: the daemon is a shared local service.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { managerStateDir } from './paths.mjs'

export function sidecarConfigFile() {
  return path.join(managerStateDir(), 'sidecars.json')
}

export function sidecarLogFile() {
  return path.join(managerStateDir(), 'sidecars.log')
}

function validEntry(s) {
  return !!s && typeof s.id === 'string' && s.id !== '' &&
    typeof s.exe === 'string' && s.exe !== ''
}

export function readSidecars() {
  try {
    const v = JSON.parse(fs.readFileSync(sidecarConfigFile(), 'utf8'))
    return Array.isArray(v.sidecars) ? v.sidecars.filter(validEntry) : []
  } catch {
    return []
  }
}

/** readSidecars + on-disk exe existence, for RPC/UI consumers. */
export function sidecarsWithStatus() {
  return readSidecars().map((s) => {
    let exeExists = false
    try {
      exeExists = fs.existsSync(s.exe)
    } catch {
      exeExists = false
    }
    return { ...s, exeExists }
  })
}

export function writeSidecars(list) {
  fs.mkdirSync(managerStateDir(), { recursive: true })
  fs.writeFileSync(sidecarConfigFile(), JSON.stringify({ sidecars: list }, null, 2) + '\n', 'utf8')
}

export function logSidecar(line) {
  try {
    fs.appendFileSync(sidecarLogFile(), new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    // logging must never break startup
  }
}

/**
 * Locate sodamem.exe across pip user-scope script directories. Scans every
 * Python version directory under %APPDATA%\Python and %LOCALAPPDATA%\Python
 * (covers pythoncore-3.14-64 style layouts). Injectable roots keep this
 * unit-testable.
 */
export function findSodamemExe({ appData = process.env.APPDATA, localAppData = process.env.LOCALAPPDATA } = {}) {
  for (const root of [appData, localAppData]) {
    if (!root) continue
    const pyRoot = path.join(root, 'Python')
    let versions = []
    try {
      versions = fs.readdirSync(pyRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      continue
    }
    for (const v of versions) {
      const candidate = path.join(pyRoot, v, 'Scripts', 'sodamem.exe')
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        // ignore
      }
    }
  }
  return null
}

/**
 * Seed the sodamem sidecar when the engine is detected on disk and not
 * configured yet (zero-config follow-dsh-start for this machine).
 * Returns true when a seed happened.
 */
export function seedSodamemSidecar() {
  const list = readSidecars()
  if (list.some((s) => s.id === 'sodamem')) return false
  const exe = findSodamemExe()
  if (!exe) return false
  writeSidecars([
    ...list,
    {
      id: 'sodamem',
      exe,
      args: ['daemon', 'ensure', '--api-url', 'http://127.0.0.1:8000'],
      enabled: true,
    },
  ])
  logSidecar('seeded sodamem sidecar: ' + exe)
  return true
}

/**
 * Spawn every enabled sidecar, detached. Never throws: a sidecar that fails
 * to spawn is logged and surfaced in the result, nothing more.
 */
export function ensureAllSidecars() {
  const results = []
  for (const s of readSidecars()) {
    if (s.enabled === false) {
      results.push({ id: s.id, skipped: 'disabled' })
      continue
    }
    if (!fs.existsSync(s.exe)) {
      logSidecar(`${s.id}: exe missing: ${s.exe}`)
      results.push({ id: s.id, skipped: 'exe-missing' })
      continue
    }
    try {
      const args = Array.isArray(s.args) ? s.args : []
      const child = spawn(s.exe, args, {
        cwd: s.cwd || undefined,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      logSidecar(`${s.id}: spawned pid=${child.pid}: ${s.exe} ${args.join(' ')}`)
      results.push({ id: s.id, spawned: true, pid: child.pid })
    } catch (error) {
      logSidecar(`${s.id}: spawn failed: ${error && error.message ? error.message : String(error)}`)
      results.push({ id: s.id, error: String(error && error.message ? error.message : error) })
    }
  }
  return results
}

/** Activation hook: seed + spawn every enabled sidecar. Never throws. */
export function ensureSidecarsFollowDsh() {
  try {
    seedSodamemSidecar()
  } catch (error) {
    logSidecar('seed failed: ' + (error && error.message ? error.message : String(error)))
  }
  return ensureAllSidecars()
}
