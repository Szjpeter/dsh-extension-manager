// MCP health probe + upgrade detection for dsh-extension-manager.
//
// Stability rules:
//   - A probe never mutates anything: no config writes, no package installs.
//   - stdio probes spawn the server child ONLY to perform an MCP initialize
//     handshake, then always kill it (hard timeout, detached-safe).
//   - Upgrade detection only REPORTS newer versions and the exact upgrade
//     command; executing upgrades is left to the user by design.
import { spawn } from 'node:child_process'
import { getMcpEntry } from './mcp.mjs'

const PROBE_TIMEOUT_MS = 8000

// ── connectivity probes ─────────────────────────────────────────────────────

function jsonRpcInitialize() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-extension-manager', version: '0.1.0' },
    },
  }
}

async function probeHttp(entry) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(entry.url, {
      method: 'POST',
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        entry.headers && typeof entry.headers === 'object' ? entry.headers : {}
      ),
      body: JSON.stringify(jsonRpcInitialize()),
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    if (!res.ok) {
      return { reachable: false, latencyMs, detail: `HTTP ${res.status}` }
    }
    const raw = await res.text()
    // Streamable-http answers either as plain JSON or as an SSE stream whose
    // data: lines carry the JSON-RPC envelope. Accept both.
    let payload = null
    try {
      payload = JSON.parse(raw)
    } catch {
      for (const line of raw.split('\n')) {
        const s = line.trim()
        if (s.startsWith('data:')) {
          try {
            payload = JSON.parse(s.slice(5).trim())
            break
          } catch {
            // keep scanning
          }
        }
      }
    }
    if (payload && payload.result) {
      const name =
        payload.result.serverInfo && payload.result.serverInfo.name
          ? payload.result.serverInfo.name
          : null
      const version =
        payload.result.protocolVersion ||
        (payload.result.serverInfo && payload.result.serverInfo.version) ||
        null
      return { reachable: true, latencyMs, serverName: name, protocolVersion: version }
    }
    if (payload && payload.error) {
      return { reachable: true, latencyMs, detail: `handshake error: ${payload.error.message || 'unknown'}` }
    }
    return { reachable: true, latencyMs, detail: 'HTTP OK but no JSON-RPC payload recognized' }
  } catch (error) {
    const aborted = error && error.name === 'AbortError'
    return {
      reachable: false,
      latencyMs: Date.now() - started,
      detail: aborted ? `timeout after ${PROBE_TIMEOUT_MS}ms` : error && error.message ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

function probeStdioOnce(entry) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let child = null
    let buffer = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (child && child.exitCode === null) child.kill()
      } catch {
        // process already gone
      }
      resolve(Object.assign({ latencyMs: Date.now() - started }, result))
    }
    const timer = setTimeout(
      () => finish({ reachable: false, detail: `timeout after ${PROBE_TIMEOUT_MS}ms` }),
      PROBE_TIMEOUT_MS
    )
    try {
      child = spawn(entry.command, Array.isArray(entry.args) ? entry.args : [], {
        env: Object.assign({}, process.env, entry.env && typeof entry.env === 'object' ? entry.env : {}),
        cwd: typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : undefined,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ reachable: false, detail: `spawn failed: ${error && error.message}` })
      return
    }
    child.on('error', (error) => finish({ reachable: false, detail: `spawn failed: ${error.message}` }))
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      // stdio transport frames JSON-RPC messages one per line (LSP-style
      // headers are tolerated by scanning for the last JSON object line).
      for (const line of buffer.split('\n')) {
        const s = line.trim()
        if (!s.startsWith('{')) continue
        try {
          const msg = JSON.parse(s)
          if (msg.id === 1 && msg.result) {
            const name =
              msg.result.serverInfo && msg.result.serverInfo.name ? msg.result.serverInfo.name : null
            return finish({
              reachable: true,
              serverName: name,
              protocolVersion: msg.result.protocolVersion || null,
            })
          }
        } catch {
          // partial line — wait for more data
        }
      }
    })
    child.stderr.on('data', () => {
      /* servers commonly log to stderr during startup; ignore */
    })
    try {
      child.stdin.write(JSON.stringify(jsonRpcInitialize()) + '\n')
      child.stdin.end()
    } catch (error) {
      finish({ reachable: false, detail: `stdin write failed: ${error && error.message}` })
    }
  })
}

/**
 * Probe one configured MCP server by row id. Read-only.
 * Returns { ok:true, probe } or { ok:false, problem }.
 */
export async function probeMcpById(id, cwd = process.cwd()) {
  const row = getMcpEntry(id, 'global', cwd)
  if (!row || !row.config) return { ok: false, problem: `未找到 MCP 行：${id}` }
  const cfg = row.config
  if (cfg.transport === 'streamable-http') {
    if (!cfg.url) return { ok: false, problem: '该行缺少 url' }
    return { ok: true, probe: await probeHttp(cfg) }
  }
  if (!cfg.command) return { ok: false, problem: '该行缺少 command' }
  const probe = await probeStdioOnce(cfg)
  return { ok: true, probe }
}

// ── upgrade detection ───────────────────────────────────────────────────────

/**
 * Best-effort: figure out which installable package backs a stdio server and
 * which registry tracks it. Recognized launchers:
 *   npx|bunx -y <pkg> ...   -> npm
 *   pip ... install <pkg>   -> pypi
 *   uvx <pkg> ...           -> pypi
 */
export function detectUpgradeTarget(cfg) {
  if (!cfg || cfg.transport !== 'stdio') return null
  const command = String(cfg.command || '').toLowerCase()
  const args = (Array.isArray(cfg.args) ? cfg.args : []).map(String)
  if ((command.endsWith('npx') || command.endsWith('bunx')) && args.length) {
    let i = 0
    while (i < args.length && /^(-|--)/.test(args[i])) i++
    const spec = args[i]
    if (!spec) return null
    const parsed = parseNpmSpec(args[i])
    return parsed ? { ecosystem: 'npm', pkg: parsed.name, version: parsed.version || null } : null
  }
  if (command.includes('uvx') && args.length) {
    let i = 0
    while (i < args.length && /^(-|--)/.test(args[i])) i++
    const spec = args[i]
    if (!spec) return null
    const parsed = parsePypiSpec(spec)
    return parsed ? { ecosystem: 'pypi', pkg: parsed.name, version: parsed.version || null } : null
  }
  if (command.includes('pip')) {
    const idx = args.indexOf('install')
    if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('-')) {
      const parsed = parsePypiSpec(args[idx + 1])
      return parsed ? { ecosystem: 'pypi', pkg: parsed.name, version: parsed.version || null } : null
    }
  }
  return null
}

function parseNpmSpec(spec) {
  // @scope/name, @scope/name@1.2.3, name, name@range
  const at = spec.lastIndexOf('@')
  if (spec.startsWith('@') && at > 0) {
    const name = spec.slice(0, at)
    const ver = spec.slice(at + 1)
    return { name, version: /^\d/.test(ver) ? ver : null }
  }
  const m = spec.match(/^(@[^/]+\/)?([^@]+)(?:@(.+))?$/)
  if (!m) return null
  return { name: (m[1] || '') + m[2], version: m[3] && /^\d/.test(m[3]) ? m[3] : null }
}

function parsePypiSpec(spec) {
  const m = spec.match(/^([A-Za-z0-9_.-]+?)(?:[=<>!~]+.+)?$/)
  return m ? { name: m[1], version: null } : null
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`)
  return res.json()
}

/** Latest version of an npm package, or null when unpublished. */
export async function latestNpmVersion(pkg) {
  const data = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`)
  return data && typeof data.version === 'string' ? data.version : null
}

/** Latest version of a PyPI project, or null when unknown. */
export async function latestPypiVersion(pkg) {
  const data = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`)
  return data && data.info && typeof data.info.version === 'string' ? data.info.version : null
}

function upgradeCommand(target) {
  if (!target) return null
  if (target.ecosystem === 'npm') {
    return `npm install -g ${target.pkg}@${target.latest || 'latest'}`
  }
  return `pip install --upgrade ${target.pkg}`
}

/**
 * Check one configured MCP server (by row id) for an upstream update.
 * Returns { ok:true, status:'no-target'|'up-to-date'|'update-available'|'unknown-installed',
 *            target?, latest?, command?, detail? } or { ok:false, problem }.
 *
 * Installed-version discovery is deliberately NOT attempted here (running
 * package managers from a settings page is exactly the kind of surprise this
 * plugin avoids), so when we cannot know the installed version we report
 * 'unknown-installed' together with the latest version and the command.
 */
export async function checkMcpUpdateById(id, cwd = process.cwd()) {
  const row = getMcpEntry(id, 'global', cwd)
  if (!row || !row.config) return { ok: false, problem: `未找到 MCP 行：${id}` }
  const target = detectUpgradeTarget(row.config)
  if (!target) return { ok: true, status: 'no-target' }
  try {
    const latest =
      target.ecosystem === 'npm' ? await latestNpmVersion(target.pkg) : await latestPypiVersion(target.pkg)
    if (!latest) return { ok: true, status: 'unknown-installed', target, command: upgradeCommand({ ...target, latest: null }) }
    if (target.version && target.version === latest) {
      return { ok: true, status: 'up-to-date', target: { ...target, latest }, command: null }
    }
    return {
      ok: true,
      status: 'unknown-installed',
      target: { ...target, latest },
      command: upgradeCommand({ ...target, latest }),
    }
  } catch (error) {
    return { ok: false, problem: error && error.message ? error.message : String(error) }
  }
}
