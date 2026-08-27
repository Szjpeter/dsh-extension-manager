// GitHub read-only integration for the Git仓库 tab.
//
// Scope discipline (v1): public repositories only, no authentication, no
// remote write operations. Unauthenticated REST quota is 60 req/hour per IP —
// plenty for one person browsing their own repos, and every call maps rate
// limit exhaustion to a friendly message instead of a raw 403.
import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from './paths.mjs'
import { kebab } from './util.mjs'
import { writeFileAtomic } from './atomic.mjs'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const TIMEOUT_MS = 12000

function ghToken() {
  // Harness credential doctrine: secrets live in the environment / managed
  // store, never in config files. Setting GITHUB_TOKEN (or GH_TOKEN) for the
  // dsh web process lifts the anonymous 60 req/h limit to 5000 req/h and
  // unlocks private repos. Without it we stay read-only anonymous.
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
}

function ghHeaders() {
  const h = {
    'User-Agent': 'dsh-extension-manager',
    Accept: 'application/vnd.github+json',
  }
  const token = ghToken()
  if (token) h.Authorization = 'Bearer ' + token
  return h
}

async function ghFetch(url) {
  let res
  try {
    res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    throw new Error(`网络请求失败：${error && error.message ? error.message : String(error)}`)
  }
  if (res.status === 404) return { status: 404, data: null }
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error('GitHub 匿名配额已用尽（60 次/小时），请稍后再试')
  }
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
  return { status: res.status, data: await res.json() }
}

/** Public repos of one user, newest activity first. */
export async function listUserRepos(user) {
  const clean = encodeURIComponent(String(user || '').trim())
  if (!clean) throw new Error('missing github user')
  const { data } = await ghFetch(`${API}/users/${clean}/repos?per_page=100&sort=updated`)
  return (data || []).map((r) => ({
    fullName: r.full_name,
    name: r.name,
    description: r.description || '',
    defaultBranch: r.default_branch || 'main',
    updatedAt: r.updated_at || '',
    isFork: !!r.fork,
  }))
}

/** One-level listing of a directory inside a repo. */
export async function listContents(repo, ref, dir) {
  const { status, data } = await ghFetch(`${API}/repos/${repo}/contents/${encodePath(dir)}?ref=${encodeURIComponent(ref)}`)
  if (status === 404) return []
  return (Array.isArray(data) ? data : []).map((e) => ({
    name: e.name,
    path: e.path,
    type: e.type, // 'file' | 'dir'
  }))
}

function encodePath(p) {
  return String(p || '')
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

/**
 * Detect installable units with a BOUNDED recursive walk (depth ≤3, ≤70 dirs,
 * heavy/noise dirs skipped) so monorepo layouts work without burning quota:
 *   - skills : any SKILL.md (name = its parent directory)
 *   - plugins: any directory owning a package.json (subdir-aware installs)
 * The directory listing source is injectable so the GitHub-MCP bridge can
 * drive the same walk without REST calls (see host gitBrowse).
 */
export async function detectRepoUnitsWithLister(listDir, readFile) {
  readFileFn = readFile || null
  const skills = []
  const skillSeen = new Set()
  const plugins = []
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'assets', 'docs', 'marketing',
    'test', 'tests', 'examples', 'example', 'scripts', 'tools', 'bin',
    'claude-code', 'codex', 'workbuddy', 'openclaw', 'zcode'])
  const MAX_DIRS = 70
  let dirsVisited = 0

  function parentName(dir) {
    const parts = String(dir || '').split('/').filter(Boolean)
    return parts.length ? parts[parts.length - 1] : null
  }

  async function walk(dir, depth) {
    if (dirsVisited >= MAX_DIRS || depth > 3) return
    // Errors propagate deliberately: rate-limit/network failures must reach
    // the UI as a message, not masquerade as an empty repo.
    const entries = await listDir(dir)
    dirsVisited++
    let hasPkg = false
    for (const e of entries) {
      if (e.type !== 'file') continue
      if (e.name === 'package.json') hasPkg = true
      else if (e.name === 'SKILL.md') {
        const key = e.path
        if (!skillSeen.has(key)) {
          skillSeen.add(key)
          skills.push({ name: parentName(dir) || (repoLabelFallback() || 'skill'), path: e.path })
        }
      }
    }
    if (hasPkg) {
      const cls = await classifyPackage(dir, entries)
      plugins.push({
        path: dir || '',
        label: dir || '(仓库根目录)',
        kind: cls.kind,
        name: cls.name || '',
      })
    }
    for (const e of entries) {
      if (e.type === 'dir' && !SKIP.has(e.name)) await walk(e.path, depth + 1)
    }
  }

  await walk('', 1)
  return { skills, plugins }
}

// Classification decides whether an install button makes sense — this turns a
// raw listing into an answer for the user:
//   dsh-plugin  → package.json carries the harness `dsh` field, OR the same
//                 directory ships a cordis composition artifact
//                 (cordis.patch.yml / agent.cordis.yml)
//   mcp-server  → MCP 服务包（bin 入口或名称含 mcp）：以服务器形式运行，不走插件安装
//   read-error  → package.json could NOT be fetched/decoded after a retry —
//                 shown as 读取失败 instead of being silently mislabeled
//                 非 DSH 插件 (this exact masking produced the SodaMem bug)
//   unknown     → 其余 npm 包：与 DSH 插件机制无关
async function classifyPackage(dir, entries) {
  const files = Array.isArray(entries) ? entries : []
  const hasCordisArtifact = files.some(
    (e) => e && e.type === 'file' && (e.name === 'cordis.patch.yml' || e.name === 'agent.cordis.yml')
  )
  if (!readFileFn) {
    return hasCordisArtifact ? { kind: 'dsh-plugin', name: '' } : { kind: 'unknown', name: '' }
  }
  let pkg = null
  for (let attempt = 0; attempt < 2 && !pkg; attempt++) {
    try {
      const text = await readFileFn(dir ? dir + '/package.json' : 'package.json')
      pkg = JSON.parse(text)
    } catch {
      // transient fetch/decode failures get ONE retry before giving up
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  if (!pkg) {
    if (hasCordisArtifact) return { kind: 'dsh-plugin', name: '' }
    return { kind: 'read-error', name: '' }
  }
  if (pkg && typeof pkg.dsh === 'object') return { kind: 'dsh-plugin', name: pkg.name || '' }
  if (hasCordisArtifact) return { kind: 'dsh-plugin', name: pkg.name || '' }
  const mcpish = /mcp/i.test(String(pkg.name || '')) || !!pkg.bin
  if (mcpish) return { kind: 'mcp-server', name: pkg.name || '' }
  return { kind: 'unknown', name: pkg.name || '' }
}
let readFileFn = null

// Optional label used only when a SKILL.md sits at the very root.
let _repoNameHint = ''
export function setRepoNameHint(hint) { _repoNameHint = hint || '' }
function repoLabelFallback() { return _repoNameHint }

/** Raw file text from the repo. */
export async function fetchRawFile(repo, ref, filePath) {
  const url = `${RAW}/${repo}/${encodeURIComponent(ref)}/${encodePath(filePath)}`
  let res
  try {
    res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    throw new Error(`网络请求失败：${error && error.message ? error.message : String(error)}`)
  }
  if (res.status === 404) throw new Error(`文件不存在：${filePath} @ ${ref}`)
  if (!res.ok) throw new Error(`raw HTTP ${res.status}`)
  return res.text()
}

/**
 * Shared skill-install body used by BOTH the REST path (installSkillFromRepo)
 * and the GitHub-MCP bridge path (host gitInstallSkill): identical
 * exists/force semantics and ONE atomic temp+rename write — this block used
 * to exist as three near-identical copies.
 */
export function installSkillTextToUserRoot({ name, text, force }) {
  const clean = kebab(name)
  if (!clean) return { ok: false, invalidName: true }
  const dir = path.join(dshHome(), 'skills', clean)
  const file = path.join(dir, 'SKILL.md')
  const exists = fs.existsSync(file)
  if (exists && !force) {
    return { ok: false, exists: true, name: clean, file }
  }
  fs.mkdirSync(dir, { recursive: true })
  writeFileAtomic(file, text)
  return { ok: true, name: clean, file, overwritten: exists }
}

/**
 * Install a skill from a repo file into the user skills root.
 * Never overwrites an existing skill unless force=true; the caller surfaces
 * a confirmation in that case. Write goes through the shared atomic writer.
 */
export async function installSkillFromRepo({ repo, ref, filePath, suggestedName, force }) {
  const text = await fetchRawFile(repo, ref, filePath)
  const result = installSkillTextToUserRoot({
    name: suggestedName || deriveSkillName(filePath) || ('gh-' + Date.now()),
    text,
    force,
  })
  if (result.invalidName) throw new Error('无法从路径推导技能名，请提供名称')
  return result
}

function deriveSkillName(filePath) {
  const parts = String(filePath || '').split('/')
  // skills/<name>/SKILL.md | <name>/SKILL.md | SKILL.md
  for (let i = parts.length - 1; i >= 1; i--) {
    if (parts[i] === 'SKILL.md') return parts[i - 1]
  }
  return parts.length >= 2 ? parts[parts.length - 2] : null
}
