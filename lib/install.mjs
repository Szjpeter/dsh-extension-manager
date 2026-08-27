import fs from 'node:fs'
import path from 'node:path'
import {
  dshHome,
  hostPatchPath,
  userPresetsRoot,
  userSkillsRoot,
  projectSkillsRoot,
  projectMcpManifest,
  projectRoot,
  projectSlug,
  findShippedStandardPreset,
} from './paths.mjs'
import { emit } from './emit.mjs'
import { parseYaml } from './yaml.mjs'
import { commitVerifiedWrite, previewCompositionWrite } from './writepipeline.mjs'
import { writeFileAtomic } from './atomic.mjs'
import * as region from './region.mjs'

// ── Skills ──────────────────────────────────────────────────────────────────

export function skillTargetDir(scope, cwd = process.cwd()) {
  return scope === 'project' ? projectSkillsRoot(cwd) : userSkillsRoot()
}

// v0.2.2 slimming: installSkill() was removed — the GitHub skill installer
// now owns its shared atomic writer (github.installSkillTextToUserRoot) and
// no other caller remained.

export function removeSkill(name, scope, cwd = process.cwd()) {
  const dir = path.join(skillTargetDir(scope, cwd), name)
  const removed = []
  for (const f of [path.join(dir, 'SKILL.md'), path.join(skillTargetDir(scope, cwd), `${name}.md`)]) {
    if (fs.existsSync(f)) {
      fs.rmSync(f)
      removed.push(f)
    }
  }
  // prune empty bundle dir
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmSync(dir, { recursive: true, force: true })
  return removed
}

export function findSkillFile(name, scope, cwd = process.cwd()) {
  const root = skillTargetDir(scope, cwd)
  for (const f of [path.join(root, name, 'SKILL.md'), path.join(root, `${name}.md`)]) {
    if (fs.existsSync(f)) return f
  }
  return null
}

// Enable/disable a skill by setting or removing the DSH frontmatter flags
// `disable-model-invocation` / `user-invocable`. Other frontmatter content is
// preserved verbatim.
export function toggleSkill(name, scope, disabled, cwd = process.cwd()) {
  const file = findSkillFile(name, scope, cwd)
  if (!file) throw new Error(`skill not found: ${name} (${scope})`)
  const text = fs.readFileSync(file, 'utf8')
  const updated = toggleSkillFrontmatter(text, disabled)
  writeFileAtomic(file, updated)
  return { file, name, disabled }
}

function toggleSkillFrontmatter(text, disable) {
  const norm = text.replace(/\r\n/g, '\n')
  if (!norm.startsWith('---')) {
    // No frontmatter: synthesize one.
    const header = disable ? '---\ndisable-model-invocation: true\nuser-invocable: false\n---\n\n' : '---\n---\n\n'
    return header + norm
  }
  const endIdx = norm.indexOf('\n---', 3)
  if (endIdx === -1) {
    // malformed; fall back to append a header
    return disable ? '---\ndisable-model-invocation: true\nuser-invocable: false\n---\n\n' + norm : norm
  }
  const headerBody = norm.slice(4, endIdx)
  // The closing marker occupies endIdx..endIdx+3 ('\n---'); the rest begins
  // after it so the rebuilt header is not followed by a duplicate '---'.
  const rest = norm.slice(endIdx + 4)
  let lines = headerBody.split('\n').filter((l) => !/^\s*(disable-model-invocation|user-invocable)\s*:/.test(l.trim()))
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  if (disable) {
    lines.push('disable-model-invocation: true')
    lines.push('user-invocable: false')
  }
  const newHeader = '---\n' + lines.join('\n') + '\n---'
  return newHeader + rest
}

// ── MCP: global (host patch) ────────────────────────────────────────────────
// Patch files are PATCH OPERATION lists: rows must be wrapped in `- insert:`
// blocks — a bare top-level `- id:` row means "override", which silently
// no-ops when the target does not exist. Writes go through the managed region.

export function installMcpGlobal(entries) {
  const patch = hostPatchPath()
  const out = []
  for (const entry of entries) {
    region.upsertServer(patch, entry)
    out.push({ id: entry.id, serverName: entry.config.serverName, path: patch })
  }
  return out
}

export function removeMcpGlobal(serverName) {
  const patch = hostPatchPath()
  const id = serverName.startsWith('mcp-') ? serverName : `mcp-${serverName}`
  region.removeServer(patch, id)
  return { id, path: patch }
}

export function toggleMcpGlobal(serverName, disabled) {
  const patch = hostPatchPath()
  const id = serverName.startsWith('mcp-') ? serverName : `mcp-${serverName}`
  region.setServerDisabled(patch, id, disabled)
  return { id, disabled, path: patch }
}

// ── MCP: project (manifest + generated preset) ──────────────────────────────

export function readMcpManifest(cwd = process.cwd()) {
  const file = projectMcpManifest(cwd)
  if (!fs.existsSync(file)) return []
  try {
    const v = parseYaml(fs.readFileSync(file, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function writeMcpManifest(entries, cwd = process.cwd()) {
  const file = projectMcpManifest(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeFileAtomic(file, emit(entries) + '\n')
  return file
}

/**
 * Remove one row from a manifest FILE PATH (not a cwd) — used by the
 * layer-routing removeMcp when a listed row only exists in the project
 * manifest. Same plain-data file, so the atomic writer suffices.
 */
export function removeRowFromManifestFile(manifestFile, id) {
  let entries = []
  try {
    const parsed = parseYaml(fs.readFileSync(manifestFile, 'utf8'))
    entries = Array.isArray(parsed) ? parsed : []
  } catch {
    return false
  }
  const kept = entries.filter((e) => !(e && typeof e === 'object' && e.id === id))
  if (kept.length === entries.length) return false
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
  writeFileAtomic(manifestFile, emit(kept) + '\n')
  return true
}

function projectPresetDir(cwd = process.cwd()) {
  return path.join(userPresetsRoot(), `${projectSlug(cwd)}-mcp`)
}

function projectPresetFile(cwd = process.cwd()) {
  return path.join(projectPresetDir(cwd), 'agent.cordis.yml')
}

// Generate (or refresh) the dedicated project-MCP preset. The preset is a copy
// of the shipped `standard` composition plus a managed region holding this
// project's MCP rows, so project MCP servers become selectable per session.
export function ensureProjectPreset(entries, cwd = process.cwd()) {
  const dir = projectPresetDir(cwd)
  const file = projectPresetFile(cwd)
  fs.mkdirSync(dir, { recursive: true })

  if (fs.existsSync(file)) {
    // One-time heal for presets created before v0.2.2: their managed block
    // carries the legacy "dsh-mcp-skill-manager" label this reader never
    // recognized (rows unmanageable + duplicate-insert risk on re-add).
    // Relabeling at text level makes those rows visible to the standard
    // pipeline again; the next upsert then reconciles the region.
    const LEGACY = 'dsh-mcp-skill-manager'
    const raw = fs.readFileSync(file, 'utf8')
    if (raw.includes(LEGACY)) fs.writeFileSync(file, raw.split(LEGACY).join('dsh-extension-manager'), 'utf8')
    // Managed rows go through the standard region pipeline.
    for (const entry of entries) region.upsertServer(file, entry)
    return file
  }

  // First creation: lay down the base composition verbatim, then register
  // every row through the SAME region pipeline as later edits. Historically
  // this step hand-rolled an emit() block under a DIFFERENT marker label
  // ("dsh-mcp-skill-manager"), which the reader never recognized: those rows
  // sat outside every managed region (untoggleable/unremovable) and a second
  // add of the same server duplicated its insert id inside one document.
  const base = findShippedStandardPreset()
  if (!base) {
    throw new Error(
      `Cannot locate the shipped "standard" preset to use as a base for the ` +
      `project-MCP preset. Set DSH_SHIPPED_PRESETS to the agent-presets directory.`
    )
  }
  const baseText = fs.readFileSync(base, 'utf8')
  // The base drop is a composition file write: run it through the pipeline's
  // parse+verify legs (cross-layer scan is intentionally skipped — this file
  // is an ALTERNATE session root, not part of the web boot tree).
  const baseOut = baseText.replace(/\n*$/, '\n') + '\n'
  const seedGuard = previewCompositionWrite({ filePath: file, nextText: baseOut })
  if (!seedGuard.ok) throw new Error(`预演校验未通过：${seedGuard.problems.join('；')}`)
  writeFileAtomic(file, baseOut)
  for (const entry of entries) region.upsertServer(file, entry)

  const presetYml = path.join(dir, 'preset.yml')
  if (!fs.existsSync(presetYml)) {
    fs.writeFileSync(
      presetYml,
      `name: Project MCP: ${path.basename(projectRoot(cwd))}\n` +
      `description: Generated by dsh-extension-manager. Standard tools plus this project's MCP servers.\n`,
      'utf8',
    )
  }
  return file
}

export function installMcpProject(entries, cwd = process.cwd()) {
  // Merge with existing manifest.
  const existing = readMcpManifest(cwd)
  const byId = new Map()
  for (const e of existing) if (e && e.id) byId.set(e.id, e)
  for (const e of entries) byId.set(e.id, e)
  const merged = [...byId.values()]
  const manifest = writeMcpManifest(merged, cwd)
  const preset = ensureProjectPreset(entries, cwd)
  return { manifest, preset, ids: merged.map((e) => e.id) }
}

// v0.2.2 slimming: cwd-coupled removeMcpProject()/toggleMcpProject() were
// removed — the layer-routing layer in mcp.mjs now dispatches on a row's
// actual location (preset file path / manifest path) instead of requiring
// the caller to guess the owning project cwd.
