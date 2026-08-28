// Plugin enumeration and provenance classification for the extension-manager
// plugin manager tab.
//
// The Loader flattens every composition layer (built-in bundles, user
// bundles, profile/home/overlay patches) into entries and does not retain
// which layer contributed a row, so provenance is recovered by re-reading
// the built-in bundles' patch files: any entry whose id (or module name)
// was declared by an @deepseek-ai/* bundle in the profile's
// dsh.profile.bundles list is "official"; everything else (user profile
// patch rows, user bundles, overlays) is "other".
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dshHome } from './paths.mjs'
import { upsertServer } from './region.mjs'
import { commitVerifiedWrite } from './writepipeline.mjs'
import { sleepSync } from './atomic.mjs'
import { searchRepositoriesByName, fetchRawFile } from './github.mjs'
import { parseYaml } from './yaml.mjs'

const execFileAsync = promisify(execFile)

// Cordis FiberState -> phase name (mirror of the cross-package const enum;
// disposed fibers expose no entry and never reach here).
const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  5: 'unloading',
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Bundles owned by the harness vendor (@deepseek-ai scope) from the profile manifest. */
export function officialBundleNames(webProfileDir) {
  const manifest = readJson(path.join(webProfileDir, 'package.json'))
  const bundles = manifest && Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles
    : []
  const official = bundles.filter((name) => typeof name === 'string' && name.startsWith('@deepseek-ai/'))
  return official.length > 0 ? official : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
}

/**
 * Every row id and module name declared by the built-in bundles' patch
 * files. Entries matching these are classified as official plugins.
 */
export function officialPluginIds(webProfileDir) {
  const ids = new Set()
  const require = createRequire(path.join(webProfileDir, '__noop__.js'))
  for (const bundle of officialBundleNames(webProfileDir)) {
    try {
      const pkgPath = require.resolve(`${bundle}/package.json`)
      const pkg = readJson(pkgPath)
      const rel = pkg && typeof pkg.dsh?.bundle?.patch === 'string' ? pkg.dsh.bundle.patch : null
      if (!rel) continue
      const text = fs.readFileSync(path.join(path.dirname(pkgPath), rel), 'utf8')
      for (const match of text.matchAll(/^\s*- id:\s*(\S+)/gm)) ids.add(match[1])
      for (const match of text.matchAll(/^\s*(?:- |\s{2,})name:\s*(['"]?)([^'"\s]+)\1\s*$/gm)) ids.add(match[2])
    } catch {
      // bundle unresolvable from the profile; skip it
    }
  }
  return ids
}

/** Best-effort human description for a plugin module name (package.json description). */
function pluginDescription(require, name) {
  if (typeof name !== 'string' || name === '') return ''
  const resolved = toFilePath(name)
  if (path.isAbsolute(resolved)) {
    // Local path plugin (--patch overlay): walk up to the nearest package.json.
    let dir = resolved
    try {
      if (fs.statSync(resolved).isFile()) dir = path.dirname(resolved)
    } catch {
      return ''
    }
    let current = dir
    for (;;) {
      const pkg = readJson(path.join(current, 'package.json'))
      if (pkg && typeof pkg.description === 'string') return pkg.description
      const parent = path.dirname(current)
      if (parent === current) return ''
      current = parent
    }
  }
  if (name.startsWith('.')) return ''
  const parts = name.split('/')
  const base = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (base === '') return ''
  try {
    const pkg = readJson(require.resolve(`${base}/package.json`))
    return pkg && typeof pkg.description === 'string' ? pkg.description : ''
  } catch {
    return ''
  }
}

/** Normalize a package.json `repository` value to an https URL ('' when absent). */
function repositoryUrl(require, name) {
  if (typeof name !== 'string' || name === '' || name.startsWith('.') || path.isAbsolute(toFilePath(name))) return ''
  const parts = name.split('/')
  const base = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (base === '') return ''
  let raw = null
  try {
    const pkg = readJson(require.resolve(`${base}/package.json`))
    if (pkg) {
      const repo = pkg.repository
      raw = typeof repo === 'string' ? repo : (repo && typeof repo === 'object' && typeof repo.url === 'string' ? repo.url : null)
    }
  } catch {
    return ''
  }
  if (!raw || typeof raw !== 'string' || raw === '') return ''
  let url = raw.trim()
  // Strip npm's shorthand forms down to a plain https URL.
  if (url.startsWith('git+')) url = url.slice(4)
  if (url.startsWith('github:')) url = `https://github.com/${url.slice(7)}`
  if (url.startsWith('gitlab:')) url = `https://gitlab.com/${url.slice(7)}`
  if (url.startsWith('bitbucket:')) url = `https://bitbucket.org/${url.slice(10)}`
  if (url.startsWith('git://')) url = `https://${url.slice(6)}`
  if (url.startsWith('ssh://git@')) url = `https://${url.slice(10)}`
  if (url.endsWith('.git')) url = url.slice(0, -4)
  if (/^https?:\/\//.test(url)) return url
  return ''
}

/**
 * Delete one plugin row (the `- id: <id>` block, including its indented
 * children) from a composition file. Only affects rows physically present in
 * the file; built-in bundle rows are not found and report removed: false.
 */
export function removePluginRow(filePath, id) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { removed: false }
  }
  const lines = text.split('\n')
  const ranges = []
  let removedName = ''
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)- id:\s*(\S+)\s*$/)
    if (!match) continue
    // Strip YAML quoting so a quoted row id ('@scope/pkg') matches the bare id.
    const rowId = match[2].replace(/^['"]|['"]$/g, '')
    if (rowId !== id) continue
    const indent = match[1].length
    let j = i + 1
    while (j < lines.length) {
      const t = lines[j]
      if (t.trim() === '') {
        j++
        continue
      }
      const nameMatch = t.match(/^\s*name:\s*(.+?)\s*$/)
      if (nameMatch && removedName === '') removedName = nameMatch[1].replace(/^['"]|['"]$/g, '')
      const indented = t.match(/^(\s*)\S/)
      if (!indented || indented[1].length <= indent) break
      j++
    }
    let start = i
    // If the row is a child entry whose parent list (a less-indented `- ` row
    // such as `- insert:`) ends up with no children left, drop the parent too.
    if (indent > 0) {
      let parentLine = -1
      let parentIndent = -1
      for (let k = i - 1; k >= 0; k--) {
        const pm = lines[k].match(/^(\s*)- /)
        if (pm && pm[1].length < indent) {
          parentLine = k
          parentIndent = pm[1].length
          break
        }
      }
      if (parentLine >= 0) {
        let k = j
        let hasChild = false
        while (k < lines.length) {
          const t = lines[k]
          if (t.trim() === '') {
            k++
            continue
          }
          const cm = t.match(/^(\s*)\S/)
          if (!cm || cm[1].length <= parentIndent) break
          hasChild = true
          break
        }
        if (!hasChild) start = parentLine
      }
    }
    ranges.push({ start, end: j })
  }
  if (ranges.length === 0) return { removed: false }
  ranges.sort((a, b) => a.start - b.start)
  const out = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start < cursor) continue
    out.push(...lines.slice(cursor, range.start))
    cursor = range.end
  }
  out.push(...lines.slice(cursor))
  // S3: composition edit → same safety legs as every other region write
  // (backup ring rotation + atomic rename + re-read/parse verify with auto
  // restore). Previously a bare writeFileSync: a crash mid-write could leave
  // the boot-critical patch truncated with NO backup to fall back on.
  const done = commitVerifiedWrite(filePath, out.join('\n'))
  if (!done.ok) {
    return { removed: false, restored: !!done.restored, problem: done.problem || 'unknown' }
  }
  return { removed: true, name: removedName }
}

/** Directory where GitHub-discovered plugins are cloned. */
export function pluginsDir() {
  return path.join(dshHome(), 'extension-manager', 'plugins')
}

/**
 * Plugin-row module name for a local clone install. The name must point at
 * the clone's ENTRY FILE, not the clone directory: the loader hands `name`
 * straight to the Node ESM import(), which rejects drive-letter paths
 * (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) AND directory targets
 * (`ERR_UNSUPPORTED_DIR_IMPORT`) — either one crashes dsh web on startup. A
 * `file://` URL to the package main loads on every platform.
 */
export function pluginRowName(target, main) {
  return pathToFileURL(resolveCloneEntry(target, main)).href
}

/**
 * Resolve the actual entry file of a clone: `path.join(target, main)` may
 * itself be a directory (some packages point `main` at a folder); fall back
 * to the conventional index file inside it.
 */
function resolveCloneEntry(target, main) {
  const entry = path.join(target, main || '')
  try {
    if (fs.statSync(entry).isDirectory()) {
      for (const idx of ['index.js', 'index.mjs', 'index.cjs']) {
        const candidate = path.join(entry, idx)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  } catch {
    // stat failed; return the joined path as-is
  }
  return entry
}

/**
 * Convert a loader module name back to a local path when it is a `file://`
 * URL (clone rows written by pluginRowName). Package names and bare POSIX
 * paths pass through unchanged.
 */
export function toFilePath(name) {
  if (typeof name === 'string' && name.startsWith('file://')) {
    try {
      return fileURLToPath(name)
    } catch {
      return name
    }
  }
  return name
}

/**
 * Root directory of a clone plugin. Clone rows may reference the clone root
 * (legacy formats) or a file inside it (entry-file URLs since v0.2.10); both
 * collapse to the first-level directory under the managed plugins dir, which
 * is where `.git` lives. Non-clone names (npm packages, overlay paths)
 * return unchanged.
 */
export function cloneRoot(name) {
  const file = toFilePath(name)
  if (!path.isAbsolute(file)) return file
  const dir = path.resolve(pluginsDir())
  const resolved = path.resolve(file)
  if (resolved.toLowerCase().startsWith(dir.toLowerCase() + path.sep.toLowerCase())) {
    const rel = path.relative(dir, resolved)
    const top = rel.split(path.sep)[0]
    if (top && top !== '' && !rel.startsWith('..')) return path.join(dir, top)
  }
  return resolved
}

/**
 * Bundle packages declared by the profile manifest (`dsh.profile.bundles`)
 * whose bundle patch file exists on disk: `[{ pkg, patchPath }]`.
 */
export function bundlePatches(webProfileDir) {
  const manifest = readJson(path.join(webProfileDir, 'package.json'))
  const bundles = manifest && Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles
    : []
  const out = []
  for (const pkg of bundles) {
    if (typeof pkg !== 'string' || pkg === '') continue
    const patchPath = path.join(webProfileDir, 'node_modules', ...pkg.split('/'), 'cordis.patch.yml')
    if (fs.existsSync(patchPath)) out.push({ pkg, patchPath })
  }
  return out
}

/**
 * Every row id and module name registered by the profile's bundle layers.
 * Extension Hub only writes the profile patch, but a plugin may be installed
 * through the official bundle path (`dsh plugin add`): its registration row
 * lives in the bundle's own cordis.patch.yml, not the profile patch. Reading
 * both layers is what keeps the UI honest (installed badges, add-on state)
 * and prevents duplicate registration of the same package.
 */
export function bundleRegisteredNames(webProfileDir) {
  const names = new Set()
  for (const { patchPath } of bundlePatches(webProfileDir)) {
    let text
    try {
      text = fs.readFileSync(patchPath, 'utf8')
    } catch {
      continue
    }
    for (const match of text.matchAll(/^\s*- id:\s*(\S+)\s*$/gm)) {
      names.add(match[1].replace(/^['"]|['"]$/g, ''))
    }
    for (const match of text.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)) {
      names.add(match[1].replace(/^['"]|['"]$/g, ''))
    }
  }
  return names
}

/** Slugs of plugins whose registration row exists in the profile patch. */
export function registeredSlugs(webProfileDir) {
  const slugs = new Set()
  let text = ''
  try {
    text = fs.readFileSync(path.join(webProfileDir, 'cordis.patch.yml'), 'utf8')
  } catch {
    return slugs
  }
  const dir = pluginsDir()
  for (const match of text.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)) {
    const value = toFilePath(match[1])
    if (path.isAbsolute(value)) {
      if (value.toLowerCase().startsWith(dir.toLowerCase() + path.sep.toLowerCase())) {
        // The row may point at the clone root (legacy formats) or at an entry
        // file inside it (v0.2.10+): the slug is always the first-level
        // directory under the managed plugins dir.
        const rel = path.relative(dir, value)
        if (rel !== '' && !rel.startsWith('..')) {
          slugs.add(rel.split(path.sep)[0].toLowerCase())
        }
      }
    } else {
      // Bundle-style row (npm package name, e.g. id: extension-manager with
      // name: dsh-extension-manager): register the bare name as an install key.
      slugs.add(value.replace(/^['"]|['"]$/g, '').toLowerCase())
    }
  }
  // Also accept explicit row ids matching the clone slug. Quoted ids
  // (e.g. '@scope/pkg') are stripped so the slug matches the bare package name.
  for (const match of text.matchAll(/^\s*- id:\s*(\S+)\s*$/gm)) {
    slugs.add(match[1].replace(/^['"]|['"]$/g, '').toLowerCase())
  }
  // Bundle-layer rows (installed via `dsh plugin add`): their registration
  // rows live in the bundles' own patch files, not the profile patch.
  for (const name of bundleRegisteredNames(webProfileDir)) {
    slugs.add(name.toLowerCase())
  }
  return slugs
}

/**
 * Search GitHub for repositories tagged `dsh-plugin` (plus an optional free
 * query). Pageable: page starts at 1, per_page = 30. A repository counts as
 * installed only when its registration row exists in the profile patch (a
 * leftover clone without a row is NOT installed).
 */
export async function discoverPlugins(webProfileDir, query, page) {
  const pageNum = Number.isInteger(page) && page > 0 ? page : 1
  const terms = `topic:dsh-plugin${query && String(query).trim() ? ` ${String(query).trim()}` : ''}`
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(terms)}&sort=stars&order=desc&per_page=30&page=${pageNum}`
  let res
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'dsh-extension-manager', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    return { ok: false, message: error && error.message ? error.message : String(error) }
  }
  if (!res.ok) {
    if (res.status === 403) return { ok: false, message: 'GitHub API 限流（未认证每分钟 10 次），请稍后再试' }
    if (res.status === 422) return { ok: false, message: '搜索条件无效' }
    return { ok: false, message: `GitHub API HTTP ${res.status}` }
  }
  const data = await res.json()
  const installed = registeredSlugs(webProfileDir)
  const items = Array.isArray(data.items) ? data.items : []
  const repos = items.map((item) => ({
    id: item.id,
    fullName: item.full_name,
    name: item.name,
    description: item.description || '',
    stars: item.stargazers_count || 0,
    language: item.language || '',
    updatedAt: item.updated_at || '',
    htmlUrl: item.html_url || '',
    installed: installed.has(String(item.name).toLowerCase()),
  }))
  return { ok: true, repos, page: pageNum, hasMore: items.length === 30 }
}

/**
 * Validate a cloned plugin package WITHOUT touching the network: package.json
 * parses, `main` resolves to a real file, and there are zero runtime deps
 * (clone installs cannot run pnpm/npm install — bare-specifier imports would
 * fail at boot). Used for fresh clones AND for stale-directory recovery.
 */
export function validateClonePackage(base) {
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'))
  } catch {
    pkg = null
  }
  if (!pkg) {
    return { ok: false, code: 'invalid', message: '没有可用的 package.json，可能不是 dsh 插件包' }
  }
  if (typeof pkg.main !== 'string' || !fs.existsSync(path.join(base, pkg.main))) {
    return {
      ok: false,
      code: 'invalid',
      message: 'package.json 的 main 入口缺失或不存在。注意：GitHub 安装获取的是源码而非构建产物，TypeScript 等需要构建的仓库请改用 npm 安装（或确认仓库已提供构建产物）',
    }
  }
  const runtimeDeps = pkg.dependencies && typeof pkg.dependencies === 'object'
    ? Object.keys(pkg.dependencies).filter((k) => pkg.dependencies[k])
    : []
  if (runtimeDeps.length > 0) {
    return {
      ok: false,
      code: 'invalid',
      message: `该插件带有 ${runtimeDeps.length} 个 npm 运行时依赖（${runtimeDeps.slice(0, 3).join(', ')}${runtimeDeps.length > 3 ? '…' : ''}），克隆安装仅支持零依赖插件，请改用 npm 安装`,
    }
  }
  return { ok: true, pkg }
}

/**
 * Write the registration row for an already-on-disk clone and verify it
 * landed. Returns { ok, message? } — on failure the clone directory is left
 * intact (it is valid; the operator can retry or remove it manually).
 */
/**
 * Plugins that REQUIRE config ship their defaults in the bundle layer's
 * cordis.patch.yml (e.g. sodamem's apiUrl is required — a config-less row
 * fails loader activation and can break `dsh web` boot). Merge the first
 * config-bearing insert row of that patch into the row we register, but ONLY
 * when the config is plain-serializable: `!!js` expressions parse to
 * {__js} sentinels we cannot faithfully re-emit, so such configs are skipped
 * (behavior falls back to today's config-less row).
 */
function extractBundleConfig(bundlePatchPath) {
  let parsed = null
  try {
    parsed = parseYaml(fs.readFileSync(bundlePatchPath, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.insert)) continue
    for (const row of entry.insert) {
      if (row && typeof row === 'object' && row.config && typeof row.config === 'object') {
        const cfg = row.config
        const serializable = (v) => {
          if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return true
          if (Array.isArray(v)) return v.every(serializable)
          if (typeof v === 'object') {
            for (const k of Object.keys(v)) {
              if (k === '__js' || !serializable(v[k])) return false
            }
            return true
          }
          return false
        }
        if (serializable(cfg)) return cfg
      }
    }
  }
  return null
}

function registerCloneRow(webProfileDir, slug, base, pkg) {
  const patchPath = path.join(webProfileDir, 'cordis.patch.yml')
  // name must be a `file://` URL to the ENTRY FILE, not the raw Windows path
  // nor the clone directory: the loader imports it with Node ESM, which
  // rejects drive-letter specifiers (ERR_UNSUPPORTED_ESM_URL_SCHEME) and
  // directory targets (ERR_UNSUPPORTED_DIR_IMPORT) — either crashes on boot.
  const row = { id: slug, name: pluginRowName(base, pkg.main) }
  // Carry the plugin's own default config if its bundle layer defines one
  // (prevents the sodamem-class boot failure: required apiUrl absent).
  const bundleCfg = extractBundleConfig(path.join(base, 'cordis.patch.yml'))
  if (bundleCfg) row.config = bundleCfg
  upsertServer(patchPath, row)
  let wrote = false
  try {
    wrote = new RegExp(`^\\s{4}- id:\\s*${slug}\\s*$`, 'm').test(fs.readFileSync(patchPath, 'utf8'))
  } catch {
    wrote = false
  }
  if (!wrote) {
    return { ok: false, message: '注册行未能写入配置，请重启 dsh web 后重试', configMerged: !!bundleCfg }
  }
  return { ok: true, configMerged: !!bundleCfg }
}

/**
 * Decide the install channel for a repo BEFORE any side effects (user ruling:
 * ONE button, backend decides — npm first, clone fallback, else 无法安装).
 *   npm   : package published on npm under the repo's base name
 *   clone : not on npm, but the repo's package.json passes clone rules
 *           (main entry committed + zero runtime deps)
 *   none  : neither works; reason carries the user-facing explanation.
 */
export async function chooseInstallChannel(repo, subdir = '') {
  const base = String(repo.split('/')[1] || '')
  // 1) npm channel probe (cheap registry lookup; anti-squat re-checked at
  //    install time against meta.repository).
  try {
    const res = await fetch(`https://registry.npmjs.org/${registryName(base)}/latest`, { signal: AbortSignal.timeout(10000) })
    if (res.ok) return { channel: 'npm' }
  } catch {
    // registry unreachable — fall through to clone probing
  }
  // 2) clone preflight: read the remote package.json (raw 404 also proves a
  //    missing committed main, since raw serves committed files only).
  const pkgPath = (subdir ? subdir + '/' : '') + 'package.json'
  try {
    const text = await fetchRawFile(repo, 'HEAD', pkgPath)
    const pkg = JSON.parse(text)
    if (typeof pkg.main !== 'string' || pkg.main === '') {
      return {
        channel: 'none',
        reason: 'package.json 的 main 入口缺失。GitHub 安装获取的是源码而非构建产物，TypeScript 等需要构建的仓库无法克隆安装；若作者已发布 npm 包则可 npm 安装',
      }
    }
    // The main entry must be COMMITTED. A raw 404 on it (TS repos whose
    // dist/ is gitignored — the sodamem case) means a clone would brick at
    // boot; refuse here instead of after a wasted download.
    const mainPath = (subdir ? subdir + '/' : '') + String(pkg.main).replace(/^\.\//, '').replace(/^\//, '')
    try {
      await fetchRawFile(repo, 'HEAD', mainPath)
    } catch {
      return {
        channel: 'none',
        reason: 'main 入口缺失或未随仓库提交（构建产物缺失，如 dist/）。GitHub 安装获取的是源码，TypeScript 等需要构建的仓库无法克隆安装；若作者已发布 npm 包则可 npm 安装',
      }
    }
    const runtimeDeps = pkg.dependencies && typeof pkg.dependencies === 'object'
      ? Object.keys(pkg.dependencies).filter((k) => pkg.dependencies[k])
      : []
    if (runtimeDeps.length > 0) {
      return { channel: 'none', reason: `该插件带有 ${runtimeDeps.length} 个 npm 运行时依赖（${runtimeDeps.slice(0, 3).join(', ')}${runtimeDeps.length > 3 ? '…' : ''}），克隆安装仅支持零依赖插件` }
    }
  } catch (error) {
    return { channel: 'none', reason: '无法读取仓库 package.json（' + (error && error.message ? error.message : String(error)) + '）' }
  }
  return { channel: 'clone' }
}

/**
 * ONE install entry for the Git tab (user ruling): npm first, clone fallback,
 * otherwise a final 无法安装 answer. Messages record which channel served.
 */
export async function installPluginAuto(webProfileDir, repo, subdir) {
  const choice = await chooseInstallChannel(repo, subdir)
  if (choice.channel === 'none') {
    return { ok: false, code: 'invalid', message: '无法安装：' + choice.reason }
  }
  if (choice.channel === 'npm') {
    const base = String(repo.split('/')[1] || '')
    const r = await installNpmPlugin(webProfileDir, base, repo)
    if (r.ok) return { ...r, channel: 'npm', message: '已通过 npm 安装。' + r.message }
    if (r.code === 'mismatch') {
      // npm name squatted by an unrelated package — fall back to clone.
    } else {
      return { ...r, channel: 'npm' }
    }
  }
  const r = await installPlugin(webProfileDir, repo, subdir)
  return { ...r, channel: 'clone' }
}

/**
 * Clone a GitHub repository into the local plugins dir and register it as a
 * plugin row (absolute-path module) in the profile patch. No pnpm involved.
 * The row is inserted through the managed region (insert-block patch
 * semantics); it takes effect on the next dsh web start.
 *
 * Stale-directory state machine (v0.2.2): a failed clone used to leave a
 * half-created dir behind, and the "目录已存在" guard then wedged every
 * retry forever. Now: an existing dir is VALIDATED first — a good clone is
 * registered without re-cloning, a bad one is wiped and the install
 * proceeds fresh. Clone failures also clean their own partial dir.
 */
export async function installPlugin(webProfileDir, repo, subdir) {
  const full = String(repo || '').trim()
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(full)
  if (!match) return { ok: false, message: '仓库名无效，应为 owner/repo 格式' }
  const slug = match[2] + (subdir ? '-' + String(subdir).replace(/[\\/]+/g, '-') : '')
  const dir = pluginsDir()
  const target = path.join(dir, slug)
  fs.mkdirSync(dir, { recursive: true })

  // Existing directory: recover instead of wedging behind the old guard.
  if (fs.existsSync(target)) {
    const base = subdir ? path.join(target, subdir) : target
    const verdict = validateClonePackage(base)
    if (verdict.ok) {
      const reg = registerCloneRow(webProfileDir, slug, base, verdict.pkg)
      if (!reg.ok) {
        return { ok: false, code: 'invalid', message: `目录 ${slug} 已存在且校验通过，但${reg.message}` }
      }
      let message = `检测到 ${slug} 已克隆但未注册，已补写注册行，重启 dsh web 后生效`
      if (reg.configMerged) message += '；已合并插件自带的默认配置（config）'
      if (verdict.pkg.dsh && verdict.pkg.dsh.bundle && typeof verdict.pkg.dsh.bundle.patch === 'string' && !reg.configMerged) {
        message += '；注意：该插件自带 bundle 补丁，但其配置无法自动携带（可能含动态表达式）。若插件激活需要配置（如 apiUrl），请手动在托管区为该行补 config，否则可能影响启动'
      }
      return { ok: true, message, path: target }
    }
    // Bad/stale clone: wipe it and fall through to a fresh install.
    fs.rmSync(target, { recursive: true, force: true })
  }

  try {
    await execFileAsync('git', ['clone', '--depth', '1', `https://github.com/${full}.git`, target], { timeout: 120000, windowsHide: true })
  } catch (error) {
    // A failed clone still creates the target dir before the network dies —
    // leaving it behind would wedge every retry behind "目录已存在".
    try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* keep going */ }
    return { ok: false, code: 'network', message: (error && error.message ? error.message : String(error)) + '（已清理残留目录，可重试）' }
  }
  // Monorepo support: the plugin package may live in a subdirectory.
  const base = subdir ? path.join(target, subdir) : target
  const verdict = validateClonePackage(base)
  if (!verdict.ok) {
    fs.rmSync(target, { recursive: true, force: true })
    const prefix = subdir ? `子目录 ${subdir} 内` : '仓库'
    return { ok: false, code: 'invalid', message: prefix + verdict.message }
  }
  const reg = registerCloneRow(webProfileDir, slug, base, verdict.pkg)
  if (!reg.ok) {
    fs.rmSync(target, { recursive: true, force: true })
    return { ok: false, code: 'invalid', message: '插件已克隆但注册行未能写入配置，请重启 dsh web 后重试' }
  }
  // Provenance: even though a clone carries .git, recording the origin makes
  // the dir self-describing if .git is ever removed (ZIP-style update check).
  writePluginOrigin(target, full)
  // Bundle-layer config is now merged into the row (see registerCloneRow);
  // what clone installs still cannot apply: any non-row bundle operations.
  let message = `已安装 ${full}，重启 dsh web 后生效`
  if (reg.configMerged) message += '；已合并插件自带的默认配置（config）'
  if (verdict.pkg.dsh && verdict.pkg.dsh.bundle && typeof verdict.pkg.dsh.bundle.patch === 'string' && !reg.configMerged) {
    message += '；注意：该插件自带 bundle 补丁，但其配置无法自动携带（可能含动态表达式）。若插件激活需要配置（如 apiUrl），请手动在托管区为该行补 config，否则可能影响启动'
  }
  return { ok: true, message, path: target }
}

// npm package name grammar (unscoped or @scope/name, no path separators).
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/**
 * Runtime dependencies of a downloaded plugin package that are NOT present in
 * the profile's top-level node_modules. Extension Hub installs without pnpm
 * and does not fetch transitive dependencies, so a plugin whose deps are
 * missing would fail to load after restart — the caller surfaces this as a
 * reminder while the install itself still completes.
 */
export function missingRuntimeDeps(webProfileDir, pkgJson) {
  const deps = pkgJson && typeof pkgJson.dependencies === 'object' ? pkgJson.dependencies : {}
  const missing = []
  for (const dep of Object.keys(deps)) {
    if (typeof dep !== 'string' || dep === '') continue
    const p = path.join(webProfileDir, 'node_modules', ...dep.split('/'))
    if (!fs.existsSync(p)) missing.push(dep)
  }
  return missing
}

/**
 * Warning text for plugins that ship a bundle patch (`dsh.bundle.patch`):
 * DSH CLI's bundle reconcile (`dsh plugin add/list/update`) appends every
 * dependency declaring a bundle patch to `dsh.profile.bundles` without
 * looking at manual `cordis.patch.yml` rows, so a plugin Extension Hub
 * installed (manual row + dependency declaration) can end up registered
 * twice and crash `dsh web` on boot (deepseek-harness Discussion #2889).
 * Returns '' when the package has no bundle patch.
 */
export function bundlePatchWarning(pkgJson) {
  const hasBundle = !!(
    pkgJson &&
    pkgJson.dsh &&
    typeof pkgJson.dsh.bundle === 'object' &&
    typeof pkgJson.dsh.bundle.patch === 'string' &&
    pkgJson.dsh.bundle.patch !== ''
  )
  if (!hasBundle) return ''
  return '该插件带 bundle 补丁（dsh.bundle.patch），请勿再与 dsh plugin add/list/update 命令混用（DSH CLI 可能将其追加到 dsh.profile.bundles，与手动注册行重复，导致 dsh web 启动失败；详见 deepseek-harness Discussion #2889）'
}

/**
 * Install a plugin from the npm registry WITHOUT pnpm: fetch the latest
 * tarball, unpack with the system tar, place it in the profile node_modules,
 * register a bundle row (`id: <name>`) in the managed patch region, and record
 * the dependency in the profile manifest. The registry package must point back
 * at the selected repository (`expectedRepo`) — an anti-squatting check — when
 * the caller can name one.
 */
export async function installNpmPlugin(webProfileDir, pkgName, expectedRepo) {
  const name = String(pkgName || '').trim()
  if (!NPM_NAME_RE.test(name)) return { ok: false, code: 'invalid', message: 'npm 包名无效' }
  if (bundleRegisteredNames(webProfileDir).has(name.toLowerCase())) {
    return { ok: false, code: 'exists', message: `该插件已通过官方 bundle 方式安装（dsh plugin add），请在 DSH 插件管理或 dsh plugin remove 中管理，不要重复安装` }
  }
  if (registeredSlugs(webProfileDir).has(name.toLowerCase())) {
    return { ok: false, code: 'exists', message: '该插件似乎已安装' }
  }
  const encoded = registryName(name)
  let meta = null
  try {
    const res = await fetch(`https://registry.npmjs.org/${encoded}/latest`, { signal: AbortSignal.timeout(10000) })
    if (res.status === 404) return { ok: false, code: 'invalid', message: 'npm 上不存在该包' }
    if (!res.ok) return { ok: false, code: 'network', message: `registry HTTP ${res.status}` }
    meta = await res.json()
  } catch (error) {
    return { ok: false, code: 'network', message: error && error.message ? error.message : String(error) }
  }
  const version = typeof meta.version === 'string' ? meta.version : null
  const tarball = meta.dist && typeof meta.dist.tarball === 'string' ? meta.dist.tarball : null
  if (!version || !tarball) return { ok: false, code: 'invalid', message: 'registry 返回数据不完整' }
  if (expectedRepo) {
    const repoRaw = meta.repository
      ? (typeof meta.repository === 'object' ? meta.repository.url : meta.repository)
      : ''
    const repoUrl = String(repoRaw || '')
      .toLowerCase()
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .replace(/^github:/, 'https://github.com/')
    if (!repoUrl.includes(String(expectedRepo).toLowerCase())) {
      return { ok: false, code: 'mismatch', message: 'npm 包与所选仓库不匹配（可能存在名称抢占），已取消安装' }
    }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inst-'))
  const target = path.join(webProfileDir, 'node_modules', ...(name.startsWith('@') ? name.split('/') : [name]))
  const profilePkgPath = path.join(webProfileDir, 'package.json')
  const patchPath = path.join(webProfileDir, 'cordis.patch.yml')
  try {
    if (fs.existsSync(target)) return { ok: false, code: 'exists', message: 'node_modules 中已存在该包，可能已安装' }
    const tgzRes = await fetch(tarball, { signal: AbortSignal.timeout(60000) })
    if (!tgzRes.ok) return { ok: false, code: 'network', message: `download HTTP ${tgzRes.status}` }
    const tarPath = path.join(tmpDir, 'pkg.tgz')
    fs.writeFileSync(tarPath, Buffer.from(await tgzRes.arrayBuffer()))
    await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xzf', tarPath, '-C', tmpDir], { timeout: 60000, windowsHide: true })
    const pkgJson = readJson(path.join(tmpDir, 'package', 'package.json'))
    if (!pkgJson || pkgJson.name !== name || pkgJson.version !== version) {
      return { ok: false, code: 'invalid', message: '下载的包未通过校验（包名/版本不匹配）' }
    }
    if (typeof pkgJson.main !== 'string' || !fs.existsSync(path.join(tmpDir, 'package', pkgJson.main))) {
      return { ok: false, code: 'invalid', message: 'npm 包缺少可用的 package.json/main，不是有效的 dsh 插件包' }
    }
    fs.cpSync(path.join(tmpDir, 'package'), target, { recursive: true })
    // Carry the plugin's own default config from its bundle layer when one
    // ships inside the package (same sodamem-class boot-failure guard as the
    // clone channel).
    const bundleRel = pkgJson.dsh && pkgJson.dsh.bundle && typeof pkgJson.dsh.bundle.patch === 'string'
      ? pkgJson.dsh.bundle.patch : ''
    const bundleCfg = bundleRel ? extractBundleConfig(path.join(tmpDir, 'package', bundleRel)) : null
    const row = { id: name, name }
    if (bundleCfg) row.config = bundleCfg
    upsertServer(patchPath, row)
    // Record the dependency so a future pnpm install keeps the package.
    const pp = readJson(profilePkgPath)
    if (pp && pp.dependencies && typeof pp.dependencies === 'object') {
      pp.dependencies[name] = '^' + version
      try {
        fs.writeFileSync(profilePkgPath, JSON.stringify(pp, null, 2) + '\n', 'utf8')
      } catch {
        // manifest update is best-effort; the node_modules copy is the source of truth
      }
    }
    // Self-check: registration row AND installed dir must both exist.
    let wrote = false
    try {
      wrote = new RegExp(`^\\s{4}- id:\\s*['"]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'm')
        .test(fs.readFileSync(patchPath, 'utf8'))
    } catch {
      wrote = false
    }
    if (!wrote || !fs.existsSync(target)) {
      try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* keep going */ }
      if (pp && pp.dependencies) {
        try {
          delete pp.dependencies[name]
          fs.writeFileSync(profilePkgPath, JSON.stringify(pp, null, 2) + '\n', 'utf8')
        } catch { /* keep going */ }
      }
      return { ok: false, code: 'invalid', message: '插件已安装但注册行未能写入配置，请重启 dsh web 后重试' }
    }
    const missing = missingRuntimeDeps(webProfileDir, pkgJson)
    const bundleWarn = bundlePatchWarning(pkgJson)
    let message = `已安装 ${name}@${version}（npm），重启 dsh web 后生效`
    if (missing.length > 0) {
      message += `；注意：该插件还需要依赖 ${missing.join('、')}，当前 profile 中未检测到，重启后若插件加载失败，请在 profile 目录执行 pnpm install 补齐`
    }
    if (bundleWarn !== '') {
      message += `；${bundleWarn}`
    }
    return { ok: true, kind: 'npm', name, version, message }
  } catch (error) {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* keep going */ }
    return { ok: false, code: 'network', message: error && error.message ? error.message : String(error) }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* keep going */ }
  }
}

// Cordis include is the composition loader itself (bundle + patch merge);
// it is system-critical and must never be disabled or removed.
const CORE_PLUGIN_NAMES = new Set(['cordis:include'])

/**
 * Snapshot of every non-group Loader entry with provenance classification.
 * @param ctx - plugin context that can reach the `loader` service.
 * @param webProfileDir - web profile directory (composition + dependency root).
 */
export function listPlugins(ctx, webProfileDir) {
  const loader = ctx.get('loader')
  const plugins = []
  if (loader) {
    const official = officialPluginIds(webProfileDir)
    const require = createRequire(path.join(webProfileDir, '__noop__.js'))
    for (const entry of loader.entries()) {
      if (entry.options.group) continue
      const name = cloneRoot(entry.options.name)
      // Provenance: vendor scope (@deepseek-ai/*) means an official plugin —
      // rows the vendor bundles OR rows a user configures with an official
      // package are both official. Bundle-row ids are kept as a fallback for
      // any future non-scoped vendor row. Everything else is "other".
      const isOfficial = (typeof name === 'string' && name.startsWith('@deepseek-ai/')) || official.has(String(entry.id).replace(/^include:/, ''))
      const isCore = typeof name === 'string' && CORE_PLUGIN_NAMES.has(name)
      plugins.push({
        entryId: entry.id,
        name,
        enabled: !entry.disabled,
        phase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state] ?? 'active',
        official: isOfficial || isCore,
        core: isCore,
        description: pluginDescription(require, name),
        repository: repositoryUrl(require, name),
      })
    }
  }
  plugins.sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1
    return String(a.name).localeCompare(String(b.name))
  })
  return { plugins }
}

// ── updates ──────────────────────────────────────────────────────────────────

function registryName(name) {
  return name.startsWith('@') ? name.replace('/', '%2F') : name
}

// G2: Windows AV/indexer locks can make a recursive delete fail transiently.
// A bounded retry beats both the old single shot AND the previous
// copy-pasted nested try/catch that "retried" with the identical call.
function rmSyncRetry(dir) {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    } catch (error) {
      if (i >= 2) return false
      sleepSync(100 * (i + 1))
    }
  }
}

/**
 * Upgrade one npm package inside the web profile WITHOUT pnpm: fetch the
 * latest registry metadata, download its tarball, unpack with the system tar,
 * replace node_modules/<name>, and update the profile dependency declaration.
 * Avoids pnpm's symlink requirements (Windows developer mode / admin).
 */
export async function updateNpmPackage(webDir, pkgName) {
  const encoded = registryName(pkgName)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upd-'))
  try {
    const res = await fetch(`https://registry.npmjs.org/${encoded}/latest`, { signal: AbortSignal.timeout(10000) })
    if (res.status === 404) return { ok: false, message: 'package not published on npm' }
    if (!res.ok) return { ok: false, message: `registry HTTP ${res.status}` }
    const meta = await res.json()
    const latest = meta && typeof meta.version === 'string' ? meta.version : null
    if (!latest) return { ok: false, message: 'registry returned no version' }
    const tarball = meta.dist && typeof meta.dist.tarball === 'string'
      ? meta.dist.tarball
      : `https://registry.npmjs.org/${encoded}/-/${pkgName.split('/').pop()}-${latest}.tgz`
    const tgzRes = await fetch(tarball, { signal: AbortSignal.timeout(60000) })
    if (!tgzRes.ok) return { ok: false, message: `download HTTP ${tgzRes.status}` }
    const tarPath = path.join(tmpDir, 'pkg.tgz')
    fs.writeFileSync(tarPath, Buffer.from(await tgzRes.arrayBuffer()))
    await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xzf', tarPath, '-C', tmpDir], { timeout: 60000, windowsHide: true })
    const pkgJson = readJson(path.join(tmpDir, 'package', 'package.json'))
    if (!pkgJson || pkgJson.name !== pkgName || pkgJson.version !== latest) {
      return { ok: false, message: 'downloaded package failed validation' }
    }
    const target = path.join(webDir, 'node_modules', ...(pkgName.startsWith('@') ? pkgName.split('/') : [pkgName]))
    rmSyncRetry(target)
    fs.cpSync(path.join(tmpDir, 'package'), target, { recursive: true })
    const profilePkg = path.join(webDir, 'package.json')
    const pp = readJson(profilePkg)
    if (pp && pp.dependencies && typeof pp.dependencies[pkgName] === 'string') {
      pp.dependencies[pkgName] = '^' + latest
      fs.writeFileSync(profilePkg, JSON.stringify(pp, null, 2) + '\n', 'utf8')
    }
    return { ok: true, version: latest }
  } catch (error) {
    return { ok: false, message: error && error.message ? String(error.message) : String(error) }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/**
 * Origin provenance for plugin dirs WITHOUT `.git` (ZIP downloads, manual
 * installs): a 2-field JSON the installer (human or AI) drops next to
 * package.json. Without it a source-less dir cannot be update-checked at all.
 *   { "repo": "owner/repo" }
 */
export function writePluginOrigin(dir, repo) {
  const clean = String(repo || '').trim()
  if (!/^([\w.-]+)\/([\w.-]+)$/.test(clean)) return false
  try {
    fs.writeFileSync(
      path.join(dir, '.dsh-plugin-origin.json'),
      JSON.stringify({ repo: clean, installedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8'
    )
    return true
  } catch {
    return false
  }
}

function readPluginOrigin(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, '.dsh-plugin-origin.json'), 'utf8'))
    return v && typeof v.repo === 'string' && v.repo.includes('/') ? v.repo : null
  } catch {
    return null
  }
}

/** Lightweight semver-ish compare: >0 when a is newer, 0 equal, <0 older. Non-numeric parts fall back to string inequality. */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.')
  const pb = String(b || '').split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i], 10)
    const nb = parseInt(pb[i], 10)
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na > nb ? 1 : -1
    } else if ((pa[i] || '') !== (pb[i] || '')) {
      return (pa[i] || '') > (pb[i] || '') ? 1 : -1
    }
  }
  return 0
}

async function fetchRemotePackage(repo) {
  const url = `https://raw.githubusercontent.com/${repo}/HEAD/package.json`
  const res = await fetch(url, { headers: { 'User-Agent': 'dsh-extension-manager' }, signal: AbortSignal.timeout(12000) })
  if (!res.ok) throw new Error(`raw HTTP ${res.status}`)
  const pkg = JSON.parse(await res.text())
  return pkg && typeof pkg === 'object' ? pkg : null
}

async function fetchRemotePackageVersion(repo) {
  const pkg = await fetchRemotePackage(repo)
  return pkg && typeof pkg.version === 'string' ? pkg.version : ''
}

/**
 * Auto-resolve the source repo for a ZIP/manual plugin dir. Order:
 *   1. provenance file (.dsh-plugin-origin.json);
 *   2. GitHub search by the LOCAL package.json name, then CONFIRM the source
 *      with two signals — remote package.json name === local name AND repo
 *      base name === local name. Confirmed sources are persisted so later
 *      checks skip the search quota.
 * Returns { repo, via } where via is 'file' | 'search' | null.
 */
async function resolveZipOrigin(root) {
  const known = readPluginOrigin(root)
  if (known) return { repo: known, via: 'file' }
  const localPkg = readJson(path.join(root, 'package.json'))
  const localName = localPkg && typeof localPkg.name === 'string' ? localPkg.name : ''
  if (!localName) return { repo: null, via: null }
  let candidates = []
  try {
    candidates = await searchRepositoriesByName(localName)
  } catch {
    return { repo: null, via: null }
  }
  for (const full of candidates) {
    try {
      const remotePkg = await fetchRemotePackage(full)
      const remoteName = remotePkg && typeof remotePkg.name === 'string' ? remotePkg.name : ''
      const repoBase = full.split('/')[1] || ''
      if (
        remoteName.toLowerCase() === localName.toLowerCase() &&
        repoBase.toLowerCase() === localName.toLowerCase()
      ) {
        writePluginOrigin(root, full)
        return { repo: full, via: 'search' }
      }
    } catch {
      // try next candidate
    }
  }
  return { repo: null, via: null }
}

/**
 * Auto-update a ZIP/manual plugin dir from its confirmed source repo:
 * download the source tarball, VALIDATE it like a fresh clone would be
 * (package.json + main entry + zero runtime deps), then swap directories
 * with a backup + rollback. Refusing is deliberate when the new source
 * fails validation — silently replacing a loadable plugin with a
 * needs-building source tree would brick it until a manual rebuild.
 */
async function zipUpdate(root, repo) {
  const localPkg = readJson(path.join(root, 'package.json'))
  const localVersion = localPkg && typeof localPkg.version === 'string' ? localPkg.version : ''
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zipupd-'))
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/tarball/HEAD`, {
      headers: { 'User-Agent': 'dsh-extension-manager' },
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) return { ok: false, message: `下载失败：HTTP ${res.status}` }
    const tgz = path.join(tmpDir, 'src.tgz')
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
    await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xzf', tgz, '-C', tmpDir], { timeout: 120000, windowsHide: true })
    const dirs = fs.readdirSync(tmpDir).filter((d) => d !== 'src.tgz' && fs.statSync(path.join(tmpDir, d)).isDirectory())
    if (dirs.length === 0) return { ok: false, message: '压缩包内没有可用的源码目录' }
    const srcBase = path.join(tmpDir, dirs[0])
    const verdict = validateClonePackage(srcBase)
    if (!verdict.ok) {
      return {
        ok: false,
        code: 'invalid',
        message: '远端源码未通过安装校验（' + verdict.message + '）。为避免静默装上无法加载的产物，本次未更新；若该插件需要构建，请在本地构建后再更新。',
      }
    }
    const backup = root + '.bak'
    try { fs.rmSync(backup, { recursive: true, force: true }) } catch { /* keep going */ }
    fs.renameSync(root, backup)
    try {
      fs.cpSync(srcBase, root, { recursive: true })
      writePluginOrigin(root, repo)
      try { fs.rmSync(backup, { recursive: true, force: true }) } catch { /* keep going */ }
      const newVersion = verdict.pkg && typeof verdict.pkg.version === 'string' ? verdict.pkg.version.replace(/^v/, '') : '?'
      return { ok: true, message: `已更新 ${repo} 至 v${newVersion}（原 v${String(localVersion).replace(/^v/, '') || '?'}），重启 dsh web 后生效` }
    } catch (swapErr) {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* keep going */ }
      try { fs.renameSync(backup, root) } catch { /* keep going */ }
      return { ok: false, message: '替换目录失败，已回滚：' + (swapErr && swapErr.message ? swapErr.message : String(swapErr)) }
    }
  } catch (error) {
    return { ok: false, message: error && error.message ? error.message : String(error) }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/**
 * Compare every non-official plugin against its update source: npm packages
 * check the registry; local git clones (discover-installed) compare HEAD to
 * origin; ZIP/manual installs (no .git) auto-resolve their source (provenance
 * file, else name search + two-signal confirm) and compare package.json
 * versions — one-click update is available for them too, via the same
 * validation/backup/rollback path as the check.
 * Built-in/official plugins are skipped (they track the DSH release).
 */
export async function checkPluginUpdates(ctx, webProfileDir) {
  const snapshot = listPlugins(ctx, webProfileDir).plugins
  const results = []
  for (const plugin of snapshot) {
    if (plugin.official || plugin.core) continue
    const name = plugin.name
    if (typeof name !== 'string' || name === '') continue
    const root = cloneRoot(name)
    if (path.isAbsolute(root)) {
      if (fs.existsSync(path.join(root, '.git'))) {
        try {
          const [localOut, remoteOut] = await Promise.all([
            execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 15000, windowsHide: true }),
            execFileAsync('git', ['-C', root, 'ls-remote', 'origin', 'HEAD'], { timeout: 15000, windowsHide: true }),
          ])
          const local = localOut.stdout.trim()
          const remote = (remoteOut.stdout.split(/\s+/)[0] || '').trim()
          results.push({
            name,
            kind: 'git',
            current: local.slice(0, 7),
            latest: remote ? remote.slice(0, 7) : '',
            updateable: !!remote && remote !== local,
          })
        } catch {
          results.push({ name, kind: 'git', current: '', latest: '', updateable: false, error: true })
        }
        continue
      }
      // No .git: resolve provenance (file → name search + two-signal
      // confirm), then compare versions. Update action itself is routed by
      // updateOnePlugin through the same resolution.
      const { repo } = await resolveZipOrigin(root)
      if (!repo) {
        results.push({ name, kind: 'zip', current: '', latest: '', updateable: false, originUnknown: true })
        continue
      }
      let localVersion = ''
      const localPkg = readJson(path.join(root, 'package.json'))
      if (localPkg && typeof localPkg.version === 'string') localVersion = localPkg.version
      try {
        const remoteVersion = await fetchRemotePackageVersion(repo)
        results.push({
          name,
          kind: 'zip',
          repo,
          current: localVersion,
          latest: remoteVersion,
          updateable: !!remoteVersion && compareVersions(remoteVersion, localVersion) > 0,
        })
      } catch {
        results.push({ name, kind: 'zip', repo, current: localVersion, latest: '', updateable: false, error: true })
      }
      continue
    }
    if (name.startsWith('.')) continue
    let current = ''
    try {
      const require = createRequire(path.join(webProfileDir, '__noop__.js'))
      const pkg = readJson(require.resolve(`${name}/package.json`))
      current = pkg && typeof pkg.version === 'string' ? pkg.version : ''
    } catch {
      // local version unresolvable
    }
    try {
      const res = await fetch(`https://registry.npmjs.org/${registryName(name)}/latest`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) {
        results.push({ name, kind: 'npm', current, latest: '', updateable: false, error: true })
        continue
      }
      const meta = await res.json()
      const latest = meta && typeof meta.version === 'string' ? meta.version : ''
      results.push({ name, kind: 'npm', current, latest, updateable: !!latest && latest !== current })
    } catch {
      results.push({ name, kind: 'npm', current, latest: '', updateable: false, error: true })
    }
  }
  return { plugins: results }
}

/**
 * Update one plugin by its source kind:
 *   git clone (.git present) → fetch + reset to origin HEAD;
 *   ZIP/manual dir           → resolve source, download tarball, validate,
 *                              swap with backup/rollback (zipUpdate);
 *   npm package name         → registry tarball replace.
 */
export async function updatePluginItem(webDir, name) {
  if (typeof name !== 'string' || name === '') return { ok: false, message: 'missing plugin name' }
  const root = cloneRoot(name)
  if (path.isAbsolute(root)) {
    if (fs.existsSync(path.join(root, '.git'))) {
      try {
        await execFileAsync('git', ['-C', root, 'fetch', 'origin', '--depth', '1'], { timeout: 60000, windowsHide: true })
        await execFileAsync('git', ['-C', root, 'reset', '--hard', 'FETCH_HEAD'], { timeout: 30000, windowsHide: true })
        return { ok: true, kind: 'git', message: '已更新本地克隆，重启 dsh web 后生效' }
      } catch (error) {
        return { ok: false, message: error && error.message ? error.message : String(error) }
      }
    }
    // ZIP/manual dir: resolve (and remember) its source, then swap.
    const { repo } = await resolveZipOrigin(root)
    if (!repo) {
      return {
        ok: false,
        message: '该目录不是 git 克隆，也没有来源档案（.dsh-plugin-origin.json，内容 {"repo":"owner/repo"}），无法自动更新；补记来源后重试',
      }
    }
    const r = await zipUpdate(root, repo)
    return { ...r, kind: 'zip' }
  }
  return updateNpmPackage(webDir, name)
}

// v0.2.2 slimming: the unused "add-on features" catalog surface
// (featureCatalog / patchRowIdByPackageName / listFeatures) was removed —
// nothing in host.js, client.js or the tests ever called it. History keeps
// the implementation if a future tab needs it back.

