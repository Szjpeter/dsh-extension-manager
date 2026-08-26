// Composition-write safety pipeline for dsh-extension-manager.
//
// FIRST PRINCIPLE: this plugin must never be able to break `dsh web` startup.
// Every write into a composition file goes through here:
//
//   1. PREVIEW  — parse the would-be file content AND cross-check row ids
//                 against every other visible composition layer, so a
//                 duplicate-id boot crash (`duplicate loader entry id`,
//                 cf. extension-hub Discussion #2889) is impossible by
//                 construction instead of by caution.
//   2. BACKUP   — keep the last N generations of the target file.
//   3. ATOMIC   — temp file + rename (see atomic.mjs).
//   4. VERIFY   — re-read from disk and re-parse; any mismatch restores the
//                 previous generation before the caller learns anything else.
//
// Layer id semantics (best-effort, conservative):
//   - `- insert: [...]` blocks register NEW rows. An id inserted by two
//     different layers crashes the loader -> hard error on collision.
//   - A bare top-level `- id: ...` row in a LATER layer OVERRIDES that row.
//     Overrides are legal, but our managed region only ever inserts, so we
//     treat "id already known in any other layer" as a collision for insert
//     operations.
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic.mjs'
import { parseYaml } from './yaml.mjs'

const BACKUP_GENERATIONS = 5

// ── parsing helpers ─────────────────────────────────────────────────────────

/** Parse a YAML composition document; returns {ok, doc} or {ok:false, error}. */
export function tryParse(text) {
  try {
    return { ok: true, doc: parseYaml(text) }
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
}

/**
 * Walk a parsed composition document and split every row into
 * inserts vs overrides. Accepts both shapes:
 *   [ { insert: [row, ...] }, { id, disabled } , row, ... ]
 */
function collectRows(doc) {
  const inserts = []
  const overrides = []
  const list = Array.isArray(doc) ? doc : []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    if (Array.isArray(entry.insert)) {
      for (const row of entry.insert) {
        if (row && typeof row === 'object' && typeof row.id === 'string' && row.id !== '') {
          inserts.push(row.id)
        }
      }
    } else if (typeof entry.id === 'string' && entry.id !== '') {
      overrides.push(entry.id)
    }
  }
  return { inserts, overrides }
}

function rowsFromFile(filePath) {
  let text = ''
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null // missing file = empty layer
  }
  const parsed = tryParse(text)
  if (!parsed.ok) return { error: `${filePath}: ${parsed.error}` }
  return collectRows(parsed.doc)
}

// ── layer scanning ──────────────────────────────────────────────────────────

/**
 * Collect row ids from every composition layer we can see, EXCLUDING the file
 * being written (its new content is validated directly instead).
 *
 * Layers scanned (all optional, missing files are empty layers):
 *   - <profileDir>/cordis.yml         (generated root)
 *   - <profileDir>/cordis.patch.yml   (profile patch)
 *   - <dshHome>/cordis.patch.yml      (home patch)
 *   - <profileDir>/node_modules/<pkg>/cordis.patch.yml for every package whose
 *     package.json declares dsh.bundle.patch pointing at it (bundle layers)
 */
export function scanLayerIds({ profileDir, dshHome }) {
  const inserts = new Map() // id -> source file
  const overrides = new Map()
  const errors = []

  const consider = (filePath) => {
    const result = rowsFromFile(filePath)
    if (!result) return
    if (result.error) {
      errors.push(result.error)
      return
    }
    for (const id of result.inserts) {
      if (!inserts.has(id)) inserts.set(id, filePath)
    }
    for (const id of result.overrides) {
      if (!overrides.has(id)) overrides.set(id, filePath)
    }
  }

  try {
    consider(path.join(profileDir, 'cordis.yml'))
    consider(path.join(profileDir, 'cordis.patch.yml'))
    consider(path.join(dshHome, 'cordis.patch.yml'))

    // Bundle layers: scan installed packages for a dsh.bundle.patch manifest.
    const modulesDir = path.join(profileDir, 'node_modules')
    const scopes = fs.existsSync(modulesDir) ? fs.readdirSync(modulesDir, { withFileTypes: true }) : []
    for (const scopeEntry of scopes) {
      const scopePath = path.join(modulesDir, scopeEntry.name)
      try {
        if (scopeEntry.isDirectory() && scopeEntry.name.startsWith('@')) {
          for (const inner of fs.readdirSync(scopePath, { withFileTypes: true })) {
            if (inner.isDirectory()) considerBundle(path.join(scopePath, inner.name))
          }
        } else if (scopeEntry.isFile() && scopeEntry.name.endsWith('.json')) {
          // pnpm/link shims are ignored; real packages are directories.
        } else if (scopeEntry.isDirectory()) {
          considerBundle(scopePath)
        }
      } catch {
        // unreadable scope directory — skip
      }
    }

    function considerBundle(pkgDir) {
      const pkgFile = path.join(pkgDir, 'package.json')
      let pkg = null
      try {
        pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
      } catch {
        return
      }
      const rel = pkg && pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
      if (typeof rel === 'string' && rel !== '') {
        consider(path.join(pkgDir, rel))
      }
    }
  } catch (error) {
    errors.push(`layer scan failed: ${error && error.message ? error.message : String(error)}`)
  }

  return { inserts, overrides, errors }
}

// ── preview ─────────────────────────────────────────────────────────────────

/**
 * Validate `nextText` for `filePath` against every other layer BEFORE writing.
 * Returns { ok: true } or { ok: false, problems: [string] }. Never writes.
 */
export function previewCompositionWrite({ filePath, nextText, profileDir, dshHome }) {
  const problems = []

  const parsed = tryParse(nextText)
  if (!parsed.ok) {
    problems.push(`新内容不是合法 YAML：${parsed.error}`)
    return { ok: false, problems }
  }

  const { inserts, overrides } = collectRows(parsed.doc)

  // Internal uniqueness inside this single document.
  const seen = new Set()
  for (const id of [...inserts, ...overrides]) {
    if (seen.has(id)) problems.push(`同一文件内行 id 重复：${id}`)
    seen.add(id)
  }

  if (profileDir && dshHome) {
    const layers = scanLayerIds({ profileDir, dshHome })
    for (const e of layers.errors) problems.push(`其他配置层解析失败（拒绝在未知状态下写入）：${e}`)
    for (const id of inserts) {
      if (layers.inserts.has(id)) {
        problems.push(
          `行 id「${id}」已在其他层注册为 insert（${layers.inserts.get(id)}）——重复 insert 会导致 dsh web 无法启动，已拒绝写入`
        )
      }
    }
  }

  return { ok: problems.length === 0, problems }
}

// ── backup + verify ─────────────────────────────────────────────────────────

function rotateBackups(filePath) {
  let current = null
  try {
    current = fs.readFileSync(filePath, 'utf8')
  } catch {
    return // nothing to back up yet
  }
  const gen = BACKUP_GENERATIONS
  try {
    const oldest = path.join(path.dirname(filePath), `.${path.basename(filePath)}.bak.${gen}`)
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true })
    for (let i = gen - 1; i >= 1; i--) {
      const from = path.join(path.dirname(filePath), `.${path.basename(filePath)}.bak.${i}`)
      const to = path.join(path.dirname(filePath), `.${path.basename(filePath)}.bak.${i + 1}`)
      if (fs.existsSync(from)) fs.renameSync(from, to)
    }
    writeFileAtomic(path.join(path.dirname(filePath), `.${path.basename(filePath)}.bak.1`), current)
  } catch {
    // Backup failure must not block the write itself; verification below still
    // guards correctness, and worst case there simply is no backup generation.
  }
}

function restoreLatestBackup(filePath) {
  for (let i = 1; i <= BACKUP_GENERATIONS; i++) {
    const candidate = path.join(path.dirname(filePath), `.${path.basename(filePath)}.bak.${i}`)
    if (fs.existsSync(candidate)) {
      const content = fs.readFileSync(candidate, 'utf8')
      writeFileAtomic(filePath, content)
      return candidate
    }
  }
  return null
}

/**
 * Backup → atomic write → verify (re-read + re-parse). On verification
 * failure the latest backup is restored automatically.
 * Returns { ok:true } or { ok:false, restored:boolean, problem:string }.
 */
export function commitVerifiedWrite(filePath, nextText, { expectYaml = true } = {}) {
  rotateBackups(filePath)
  writeFileAtomic(filePath, nextText)

  let reread = null
  try {
    reread = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    const restored = restoreLatestBackup(filePath)
    return { ok: false, restored: !!restored, problem: `回读失败：${error && error.message}` }
  }
  if (reread !== nextText) {
    const restored = restoreLatestBackup(filePath)
    return { ok: false, restored: !!restored, problem: '回读内容与写入内容不一致，已还原备份' }
  }
  if (expectYaml) {
    const check = tryParse(reread)
    if (!check.ok) {
      const restored = restoreLatestBackup(filePath)
      return { ok: false, restored: !!restored, problem: `落盘文件无法解析，已还原备份：${check.error}` }
    }
  }
  return { ok: true }
}

/**
 * One-shot helper used by simple writers: preview → commit.
 * Returns { ok:true } or { ok:false, stage:'preview'|'commit', problems|problem, restored }.
 */
export function safeCompositionWrite({ filePath, nextText, profileDir, dshHome, expectYaml = true }) {
  const preview = previewCompositionWrite({ filePath, nextText, profileDir, dshHome })
  if (!preview.ok) return { ok: false, stage: 'preview', problems: preview.problems }
  const done = commitVerifiedWrite(filePath, nextText, { expectYaml })
  if (!done.ok) return { ok: false, stage: 'commit', problem: done.problem, restored: done.restored }
  return { ok: true }
}

/**
 * Cheap single-id gate for "about to INSERT one new row" operations.
 * Refuses when the id is already registered as an insert anywhere else.
 */
export function assertInsertIdAvailable({ id, ignoreFile, profileDir, dshHome }) {
  const layers = scanLayerIds({ profileDir, dshHome })
  const hit = layers.inserts.get(id)
  if (hit && (!ignoreFile || path.resolve(hit) !== path.resolve(ignoreFile))) {
    return {
      ok: false,
      problem: `行 id「${id}」已在 ${hit} 注册——重复 insert 会导致 dsh web 无法启动`,
    }
  }
  if (layers.errors.length) {
    return { ok: false, problem: `其他配置层解析失败，拒绝写入：${layers.errors.join('; ')}` }
  }
  return { ok: true }
}
