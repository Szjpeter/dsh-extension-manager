// Residual-artifact scanning and validated purging for removed plugins.
//
// Why this module exists: uninstall used to be config-row surgery only
// (removePluginRow). A removed plugin could leave behind its npm package in
// the profile node_modules, its dependency/bundle entry in the profile
// manifest, and its data / cache / storage directories under the DSH home —
// dsh-pocket's leftover tunnel settings kept the host downloading cloudflared
// long after the plugin itself was gone. This module makes cleanup explicit
// and safe:
//   - scans only ever READ;
//   - purge deletes only directories a scan reported and the caller echoes
//     back verbatim;
//   - every purged directory must be a DIRECT child of a whitelisted root
//     (home, home/cache, home/storages) or the exact profile
//     node_modules/<name> directory;
//   - harness core directories are refused unconditionally;
//   - artifacts of plugins still registered in the composition are refused
//     unless the caller passes force.
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic.mjs'

// Directories directly under the DSH home that belong to the harness itself.
// Never orphan candidates, never purge targets.
export const HOME_CORE_DIRS = new Set([
  'profiles', 'sessions', 'storages', 'cache', 'local', 'skills', 'logs',
  'extension-manager', 'plugin-console', 'node_modules', '.agent-presets',
])

// A single path segment that can safely be a directory name under a root.
function isPlainSegment(s) {
  return typeof s === 'string' && s !== '' && !/^\.+$/.test(s) &&
    !/[\\/]/.test(s) && !/[":*?<>|]/.test(s)
}

// npm package name -> safe path segments under node_modules. Returns null for
// anything that could escape (traversal, separators beyond one scope slash).
const NPM_SEG_RE = /^[a-z0-9][a-z0-9._-]*$/i
export function npmNameSegments(name) {
  const parts = String(name || '').split('/')
  if (parts.length === 1) return NPM_SEG_RE.test(parts[0]) ? parts : null
  if (parts.length === 2) {
    if (!parts[0].startsWith('@') || parts[0].length < 2) return null
    const ok = NPM_SEG_RE.test(parts[0].slice(1)) && NPM_SEG_RE.test(parts[1])
    return ok ? parts : null
  }
  return null
}

// Best-effort package name from a composition row `name:` value. Rows can
// carry npm names ("dsh-pocket"), file URLs ("file:///...") or raw paths —
// only a plain npm-style name is a cleanup candidate on its own.
export function npmPackageName(raw) {
  const s = String(raw || '').trim()
  if (s === '') return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return '' // file:// https:// ...
  if (s.startsWith('.') || /[\\/]/.test(s)) return ''
  return npmNameSegments(s) ? s : ''
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

export function dirSizeBytes(p) {
  let entries = []
  try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return 0 }
  let total = 0
  for (const ent of entries) {
    const full = path.join(p, ent.name)
    if (ent.isDirectory()) total += dirSizeBytes(full)
    else { try { total += fs.statSync(full).size } catch { /* ignore */ } }
  }
  return total
}

function rmWithRetry(dir) {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    } catch (error) {
      if (i >= 2) return false
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1))
    }
  }
}

function purgeRoots(home) {
  return [
    { kind: 'data', root: home },
    { kind: 'cache', root: path.join(home, 'cache') },
    { kind: 'storage', root: path.join(home, 'storages') },
  ]
}

// Existing plugin-owned directories for the given names, across the three
// whitelisted roots. Read-only.
export function pluginDirs(home, names) {
  const out = []
  const seen = new Set()
  for (const raw of names || []) {
    const name = String(raw || '').trim()
    if (!isPlainSegment(name)) continue
    for (const { kind, root } of purgeRoots(home)) {
      const full = path.join(root, name)
      const key = full.toLowerCase()
      if (seen.has(key)) continue
      if (dirExists(full)) {
        seen.add(key)
        out.push({ kind, name, path: full, bytes: dirSizeBytes(full) })
      }
    }
  }
  return out
}

// Full residual picture for ONE plugin: home directories, the profile
// node_modules copy, and its package.json dependency/bundle registration.
export function scanPlugin({ home, webProfileDir, name, extraNames = [] }) {
  const pkgName = npmPackageName(name)
  const names = [pkgName, ...((extraNames || []).map((n) => String(n || '').trim()))]
    .filter((n, i, arr) => isPlainSegment(n) && arr.indexOf(n) === i)
  const dirs = pluginDirs(home, names)
  let pkg = null
  try { pkg = JSON.parse(fs.readFileSync(path.join(webProfileDir, 'package.json'), 'utf8')) } catch { /* ignore */ }
  const dep = !!(pkg && pkg.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, pkgName || '__none__'))
  const bundles = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles
    : []
  const bundle = !!pkgName && bundles.includes(pkgName)
  const segs = pkgName ? npmNameSegments(pkgName) : null
  const nmPath = segs ? path.join(webProfileDir, 'node_modules', ...segs) : null
  const nodeModules = { path: nmPath, exists: !!(nmPath && dirExists(nmPath)) }
  const totalBytes = dirs.reduce((s, d) => s + d.bytes, 0)
  const count = dirs.length + (dep ? 1 : 0) + (bundle ? 1 : 0) + (nodeModules.exists ? 1 : 0)
  return { name: pkgName || name || '', names, dirs, packageJson: { dep, bundle }, nodeModules, totalBytes, count }
}

// Orphan scan: directories under the whitelisted roots whose name belongs to
// NO live plugin (per the caller-supplied live-name set). Read-only.
export function scanOrphans({ home, liveNames }) {
  const live = new Set((liveNames || []).map((n) => String(n || '').toLowerCase()))
  const orphans = []
  for (const { kind, root, core } of purgeRoots(home).map((r) => ({ ...r, core: r.kind === 'data' ? HOME_CORE_DIRS : null }))) {
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (ent.name.startsWith('.')) continue
      if (core && core.has(ent.name)) continue
      if (live.has(ent.name.toLowerCase())) continue
      const full = path.join(root, ent.name)
      orphans.push({ kind, name: ent.name, path: full, bytes: dirSizeBytes(full) })
    }
  }
  orphans.sort((a, b) => String(a.path).localeCompare(String(b.path)))
  return { orphans, totalBytes: orphans.reduce((s, o) => s + o.bytes, 0) }
}

/**
 * Validated purge. Deletes exactly the directories in `dirs` — each must be a
 * direct child of a whitelisted root, must not be a harness core directory,
 * must not belong to a still-registered plugin (unless force), and (when
 * `names` is supplied) must bear one of those names. Optionally removes the
 * profile node_modules/<name> copy and the package.json dependency/bundle
 * entry of a single named plugin.
 */
export function purgeArtifacts({
  home, webProfileDir, names = [], dirs = [],
  removePackage = false, removeNodeModules = false,
  liveNames = [], force = false,
}) {
  const live = new Set((liveNames || []).map((n) => String(n || '').toLowerCase()))
  const wanted = new Set()
  for (const raw of names || []) {
    const n = String(raw || '').trim()
    if (isPlainSegment(n)) wanted.add(n.toLowerCase())
  }
  const removed = []
  const failed = []
  const refused = []
  let freed = 0

  for (const raw of dirs || []) {
    const target = path.resolve(String(raw || ''))
    const parent = path.dirname(target)
    const base = path.basename(target)
    if (!purgeRoots(home).some((r) => path.resolve(r.root) === parent)) {
      refused.push({ path: target, reason: 'outside-whitelisted-roots' }); continue
    }
    if (!isPlainSegment(base)) { refused.push({ path: target, reason: 'unsafe-name' }); continue }
    if (HOME_CORE_DIRS.has(base.toLowerCase())) { refused.push({ path: target, reason: 'core-directory' }); continue }
    if (wanted.size > 0 && !wanted.has(base.toLowerCase())) { refused.push({ path: target, reason: 'name-mismatch' }); continue }
    if (!force && live.has(base.toLowerCase())) { refused.push({ path: target, reason: 'plugin-still-registered' }); continue }
    if (!dirExists(target)) { refused.push({ path: target, reason: 'not-found' }); continue }
    const bytes = dirSizeBytes(target)
    if (rmWithRetry(target)) { removed.push({ path: target, bytes }); freed += bytes }
    else failed.push({ path: target, reason: 'delete-failed' })
  }

  const nodeModulesRemoved = []
  if (removeNodeModules) {
    for (const raw of names || []) {
      const name = String(raw || '').trim()
      const segs = npmNameSegments(name)
      if (!segs) continue
      if (!force && live.has(name.toLowerCase())) continue
      const target = path.join(webProfileDir, 'node_modules', ...segs)
      if (!dirExists(target)) continue
      if (rmWithRetry(target)) {
        nodeModulesRemoved.push({ path: target, name })
        // prune a scoped scope dir left empty (@scope/ with no packages left)
        if (segs.length === 2) {
          const scopeDir = path.join(webProfileDir, 'node_modules', segs[0])
          try { if (fs.readdirSync(scopeDir).length === 0) fs.rmdirSync(scopeDir) } catch { /* ignore */ }
        }
      } else failed.push({ path: target, reason: 'delete-failed' })
    }
  }

  let packageJson = null
  if (removePackage && wanted.size > 0) {
    const pkgPath = path.join(webProfileDir, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      let changed = false
      const removedDeps = []
      const removedBundles = []
      if (pkg && pkg.dependencies && typeof pkg.dependencies === 'object') {
        for (const n of wanted) {
          if (Object.prototype.hasOwnProperty.call(pkg.dependencies, n)) {
            removedDeps.push({ name: n, version: pkg.dependencies[n] })
            delete pkg.dependencies[n]
            changed = true
          }
        }
      }
      if (pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
        const before = pkg.dsh.profile.bundles.length
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => !(typeof b === 'string' && wanted.has(b.toLowerCase())))
        if (pkg.dsh.profile.bundles.length !== before) { removedBundles.push(before - pkg.dsh.profile.bundles.length); changed = true }
      }
      if (changed) {
        writeFileAtomic(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
        packageJson = { removedDeps, removedBundles }
      }
    } catch (error) {
      failed.push({ path: pkgPath, reason: error && error.message ? error.message : String(error) })
    }
  }

  return {
    ok: failed.length === 0 && refused.length === 0,
    removed, failed, refused, freed, nodeModulesRemoved, packageJson,
  }
}
