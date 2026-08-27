// MCP server create / update / get wrappers over the managed-region
// persistence.
//
// v0.2.2 layer routing: LIST shows rows from four layers (home patch /
// profile patch / presets / project manifest), so toggle/remove/probe must
// dispatch on the row's ACTUAL location. Previously every mutation hardcoded
// the web profile patch — preset/project rows shown in the UI silently
// no-op'd ("probe → 未找到", toggle/remove rewrote the wrong file and claimed
// success). Resolution order mirrors listMcp priority (home → global →
// preset → manifest), and upsert still merges STRICTLY against the TARGET
// layer so a foreign layer's config can never leak into a fresh insert.
import { hostPatchPath, projectMcpManifest } from './paths.mjs'
import { normalizeServerName } from './convert.mjs'
import {
  installMcpGlobal,
  installMcpProject,
  removeMcpGlobal,
  removeRowFromManifestFile,
  toggleMcpGlobal,
  readMcpManifest,
} from './install.mjs'
import { listMcp } from './list.mjs'
import { fileRows } from './loaderpatch.mjs'
import { removeServer, setServerDisabled, toggleMap } from './region.mjs'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

export function normalizeId(nameOrId) {
  const s = String(nameOrId || '')
  return s.startsWith('mcp-') ? s : 'mcp-' + s
}

/**
 * Resolve one MCP row across EVERY visible layer by id or serverName.
 * Returns null when the row exists nowhere visible. The `disabled` field
 * reflects the effective state INSIDE the owning layer.
 */
export function findMcpEntryAnywhere(nameOrId, cwd = process.cwd()) {
  const wanted = String(nameOrId || '')
  if (!wanted) return null
  const list = listMcp(cwd)
  const hit = list.find(
    (m) => m && typeof m === 'object' && (m.id === wanted || m.serverName === wanted)
  )
  if (!hit) return null
  let row = null
  try {
    row = fileRows(hit.location).find((r) => r && r.id === hit.id) || null
  } catch {
    row = null
  }
  return {
    id: hit.id,
    serverName: hit.serverName || (row && row.config && row.config.serverName) || hit.id,
    config: row && row.config && typeof row.config === 'object' ? row.config : null,
    transport: hit.transport,
    disabled: row ? row.disabled === true : !hit.enabled,
    enabled: hit.enabled,
    scope: hit.scope,
    source: hit.source,
    locationKind: hit.locationKind,
    location: hit.location,
    readOnly: !!hit.readOnly,
  }
}

// Strict per-scope reader retained for upsert merging: an edit must merge
// against the row IN THE TARGET LAYER, never against a lookalike elsewhere.
function getScopedEntry(id, scope, cwd = process.cwd()) {
  if (scope === 'project') {
    const row = readMcpManifest(cwd).find((e) => e && e.id === id)
    if (!row) return null
    return { ...row, disabled: false, scope, source: 'manifest' }
  }
  const row = fileRows(hostPatchPath()).find((e) => e && e.id === id)
  if (!row) return null
  return { ...row, disabled: row.disabled === true, scope, source: 'host-patch' }
}

// v0.2.2 slimming note: the scope-keyed getMcpEntry() shim was removed with
// its last consumer. Callers resolve rows via findMcpEntryAnywhere(); strict
// per-layer merging lives in getScopedEntry() for upsertMcp only.

// Merge an existing row with a partial update and produce the patch insert row.
function mergeEntry(existing, input) {
  const baseConfig = existing && existing.config ? existing.config : {}
  const config = { ...baseConfig }
  const id = input.id ? normalizeId(input.id) : normalizeId((existing && existing.id) || input.serverName || 'mcp-server')
  if (input.serverName) config.serverName = normalizeServerName(input.serverName)
  if (input.transport) config.transport = input.transport
  if (input.command !== undefined) config.command = input.command
  if (input.args !== undefined) config.args = input.args
  if (input.env !== undefined) config.env = input.env
  if (input.url !== undefined) config.url = input.url
  if (input.headers !== undefined) config.headers = input.headers
  if (config.transport === 'streamable-http') {
    delete config.command
    delete config.args
    delete config.env
    if (!config.url) throw new Error('streamable-http MCP servers require a url')
  } else {
    config.transport = 'stdio'
    delete config.url
    delete config.headers
    if (!config.command) throw new Error('stdio MCP servers require a command')
  }
  return { id, name: MCP_CLIENT, config }
}

// Create (id not managed yet) or update (id managed) one MCP server.
export function upsertMcp(input, scope, cwd = process.cwd()) {
  if (!input || (!input.serverName && !input.id)) throw new Error('MCP server requires a serverName or id')
  const id = normalizeId(input.id || input.serverName)
  const existing = getScopedEntry(id, scope === 'project' ? 'project' : 'global', cwd)
  const entry = mergeEntry(existing, input)
  if (scope === 'project') {
    const r = installMcpProject([entry], cwd)
    return { id: entry.id, serverName: entry.config.serverName, scope, manifest: r.manifest, preset: r.preset }
  }
  const r = installMcpGlobal([entry])
  return { id: entry.id, serverName: entry.config.serverName, scope, path: r[0].path }
}

/**
 * Remove one row FROM THE LAYER IT ACTUALLY LIVES IN. Read-only layers
 * (home patch) refuse loudly; absent ids are reported as a no-op instead of
 * the old silent success that still churned the global patch.
 */
export function removeMcp(nameOrId, _scopeHint, cwd = process.cwd()) {
  const loc = findMcpEntryAnywhere(nameOrId, cwd)
  if (!loc) {
    return { id: normalizeId(nameOrId), noop: true, message: `未在可见组合层找到该 MCP 行：${nameOrId}` }
  }
  if (loc.readOnly) {
    throw new Error(`行「${loc.id}」来自只读层(${loc.source})，请在 $DSH_HOME 的对应文件中手动移除`)
  }
  if (loc.locationKind === 'patch') {
    const r = removeMcpGlobal(loc.id)
    return { id: loc.id, resolved: loc.source, scope: loc.scope, path: r.path, removed: true }
  }
  if (loc.locationKind === 'preset') {
    removeServer(loc.location, loc.id)
    return { id: loc.id, resolved: loc.source, scope: loc.scope, path: loc.location, removed: true }
  }
  // locationKind === 'manifest': not materialized into any preset yet.
  removeRowFromManifestFile(loc.location, loc.id)
  return { id: loc.id, resolved: loc.source, scope: loc.scope, path: loc.location, removed: true }
}

/**
 * Enable/disable one row in its OWN layer. Without an explicit boolean the
 * current persisted state of that layer is flipped (v0.2 toggle-inversion
 * contract, now honored per-location rather than only for the global patch).
 */
export function toggleMcp(nameOrId, disabled, _scopeHint, cwd = process.cwd()) {
  const loc = findMcpEntryAnywhere(nameOrId, cwd)
  if (!loc) throw new Error(`未找到 MCP 行：${nameOrId}`)
  if (loc.readOnly) {
    throw new Error(`行「${loc.id}」来自只读层(${loc.source})，不能通过管理页切换`)
  }
  if (loc.locationKind === 'manifest') {
    throw new Error(`行「${loc.id}」仅存在于项目 manifest（尚未物化到预设），请直接编辑 ${loc.location}`)
  }
  const target =
    typeof disabled === 'boolean' ? disabled : !loc.disabled
  if (loc.locationKind === 'patch') {
    toggleMcpGlobal(loc.id, target)
  } else {
    setServerDisabled(loc.location, loc.id, target)
  }
  return { id: loc.id, disabled: target, scope: loc.scope, resolved: loc.source, path: loc.location }
}

export { projectMcpManifest }
