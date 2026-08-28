// Host half of the durable dsh-extension-manager plugin.
//
// A TypertRemoteService gateway exposed under the `extensionManager` wire
// namespace. Every Remote method is a thin JSON seam over the dependency-free
// persistence core in this package (lib/*.mjs).
//
// Mounted in the profile composition as:
//   - insert:
//       - id: extension-manager
//         name: dsh-extension-manager
//
// SELF-DEFENSE DISCIPLINE (stability first):
//   - No module-level work beyond pure definitions; nothing here can throw at
//     import time and take the whole profile down.
//   - Every mutating composition write goes through lib/writepipeline.mjs
//     (preview -> backup -> atomic -> verify).
//   - Insert-id collisions against other composition layers are refused
//     before any bytes hit the disk (see assertInsertIdAvailable).
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import fs from 'node:fs'
import path from 'node:path'
import { listAll, listSkills } from './list.mjs'
import { readSkill, createSkill, updateSkill } from './skills.mjs'
import { removeSkill, toggleSkill, toggleMcpGlobal } from './install.mjs'
import { upsertMcp, removeMcp, findMcpEntryAnywhere } from './mcp.mjs'
import { dshHome } from './paths.mjs'
import { readState, writeState } from './state.mjs'
import { normalizeServers, withServers, assertMode } from './server-mode.mjs'
import { assertInsertIdAvailable } from './writepipeline.mjs'
import { probeMcpById, checkMcpUpdateById } from './mcpcheck.mjs'
import { McpLiteHttp, McpLiteStdio } from './mcpclient-lite.mjs'
import { createBridgeCore } from './bridge-core.mjs'
import { listUserRepos, detectRepoUnitsWithLister, installSkillFromRepo, installSkillTextToUserRoot, fetchRawFile, setRepoNameHint } from './github.mjs'
import { createGitHubBridge } from './github-bridge.mjs'
import { installPluginAuto as gitInstallPlugin } from './plugins.mjs'
import { ensureSidecarsFollowDsh, readSidecars, ensureAllSidecars, sidecarsWithStatus } from './sidecars.mjs'
import { listPlugins as pluginSnapshot, removePluginRow, checkPluginUpdates as pluginUpdateScan, updatePluginItem } from './plugins.mjs'
import { scanPlugin, scanOrphans, purgeArtifacts } from './leftovers.mjs'
import { setServerDisabled, removeServer, toggleMap, listManaged, upsertServer } from './region.mjs'
import { createRequire } from 'node:module'

const VERSION = '0.3.0'

// 鈹€鈹€ three-tier plugin protection 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
//
// locked : the UI renders NO toggle/uninstall controls and the host refuses
//          mutations even if asked directly. Covers the composition spine
//          (loader, webserver, client transport/runtime, base bundle) and this
//          plugin itself 鈥?disabling any of them can end with a harness that
//          no longer boots.
// confirm: every other @deepseek-ai/* vendor row. The client asks twice.
// free   : ordinary third-party rows. Single confirmation on the client.

const LOCKED_PLUGIN_NAMES = new Set([
  'cordis:include',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-typert-loader',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-settings',
])

const SELF_ENTRY_ID = 'extension-manager'

// Cordis FiberState -> phase label (same mapping as lib/plugins.mjs).
const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  5: 'unloading',
}

function pluginTier(item) {
  const name = String(item.name || '')
  const entryId = String(item.entryId || '')
  // Composition-spine rows stay hard-locked regardless of origin.
  if (
    item.core === true ||
    LOCKED_PLUGIN_NAMES.has(name) ||
    entryId === SELF_ENTRY_ID ||
    name === 'dsh-extension-manager'
  ) return 'locked'
  // Everything else shipped by the product (runtime dir or @deepseek-ai scope)
  // is CONFIRM-tier: deliberately disableable (e.g. absorbing the native
  // plugin-list page) but never uninstallable. Origin detection keeps this
  // upgrade-proof without any list maintenance.
  if (_pluginOrigin(item) === 'runtime') return 'confirm'
  if (item.official || name.startsWith('@deepseek-ai/')) return 'confirm'
  return 'free'
}

// Loader prefixes ids of include-tree rows with "include:"; composition files
// always carry the BARE row id. Normalize before any patch-file write.
function bareEntryId(id) {
  return String(id || '').replace(/^include:/, '')
}

// Every name a plugin could own artifacts under, per the COMPOSITION truth
// (what will load next boot): managed patch rows, profile manifest
// dependencies and bundle entries. Deliberately NOT the in-memory loader 鈥?// after removePlugin the loader still carries the row until restart, and the
// post-uninstall cleanup offer must work in exactly that window.
function compositionLiveNames(webDir, patchPath) {
  const names = new Set()
  try {
    for (const e of listManaged(patchPath)) {
      if (e && Array.isArray(e.insert)) {
        for (const row of e.insert) {
          if (!row || typeof row !== 'object') continue
          if (row.id !== undefined) names.add(String(row.id).toLowerCase())
          if (row.name) names.add(String(row.name).toLowerCase())
        }
      } else if (e && e.id !== undefined) {
        names.add(String(e.id).toLowerCase())
        if (e.name) names.add(String(e.name).toLowerCase())
      }
    }
  } catch { /* read-only best effort */ }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(webDir, 'package.json'), 'utf8'))
    for (const k of Object.keys((pkg && pkg.dependencies) || {})) names.add(k.toLowerCase())
    const bundles = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
      ? pkg.dsh.profile.bundles
      : []
    for (const b of bundles) if (typeof b === 'string') names.add(b.toLowerCase())
  } catch { /* ignore */ }
  return names
}

// Conservative name set for the orphan scan: composition truth PLUS the
// in-memory loader rows (bundle patches register rows that live outside the
// profile patch). Union keeps false orphans near zero.
function orphanScanLiveNames(ctx, webDir, patchPath) {
  const names = compositionLiveNames(webDir, patchPath)
  try {
    const snap = pluginSnapshot(ctx, webDir)
    for (const p of snap.plugins || []) {
      if (p.name) names.add(String(p.name).toLowerCase())
      const bid = bareEntryId(p.entryId)
      if (bid) names.add(bid.toLowerCase())
    }
  } catch { /* ignore */ }
  return names
}

// Resolve where a plugin's module actually lives. Returns 'runtime' | 'profile'
// | 'unknown'. Best-effort: resolution failure means unknown, never throws.
function _pluginOrigin(item) {
  try {
    const rawName = String(item.name || '')
    if (!rawName) return 'unknown'
    const req = createRequire(path.join(profileDir(), '__noop__.js'))
    let resolved = null
    try {
      resolved = req.resolve(path.join(rawName, 'package.json'))
    } catch {
      resolved = req.resolve(rawName)
    }
    const runtimeRoot = path.dirname(process.execPath) // ...\DeepSeek Harness\runtime
    const profileRoot = profileDir()
    const p = path.resolve(resolved)
    if (p.startsWith(path.resolve(runtimeRoot) + path.sep)) return 'runtime'
    if (p.startsWith(path.resolve(profileRoot) + path.sep)) return 'profile'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

function profileDir() {
  return path.join(dshHome(), 'profiles', 'web')
}

// 鈹€鈹€ Remote marker plumbing (decorator-free @Remote) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const remoteMarks = []

function markRemote(proto, method, exportName) {
  const context = {
    kind: 'method',
    name: method,
    private: false,
    static: false,
    addInitializer(fn) {
      remoteMarks.push({ proto, method, exportName, fn })
    },
  }
  Remote(exportName || method)(proto[method], context)
}

function runRemoteMarks(instance) {
  const proto = Object.getPrototypeOf(instance)
  for (const mark of remoteMarks) {
    if (mark.proto === proto) mark.fn.call(instance)
  }
}

// Remote results cross the JSON boundary: strip undefined-valued properties
function jsonSafe(value) {
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) out.push(jsonSafe(item))
    return out
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      const item = jsonSafe(value[key])
      if (item !== undefined) out[key] = item
    }
    return out
  }
  return value
}

// 鈹€鈹€ Gateway 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class extensionManagerGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'extensionManager')
    runRemoteMarks(this)
    // Gateway runtime state (never serialized).
    this._lazyErrors = new Map() // serverName | serverName/tool -> message
    this._lazySetupError = null
    this._lazyTouched = false
    this._core = null
    // Test seam: when set, the bridge-core builds lite clients through this
    // factory instead of the network-backed McpLite classes.
    this._liteFactory = null
    // v0.2: apply every configured server's mode shortly after activation.
    // Fire-and-forget by design 鈥?nothing here may delay the loader tree or
    // the ready-line; failures land in `_lazyErrors` / `getLazy`.
    queueMicrotask(() => {
      try {
        this._applyConfiguredServers()
      } catch (error) {
        this._lazySetupError = error && error.message ? error.message : String(error)
      }
      // Sidecar daemons follow dsh startup (user ruling: 璺熼殢 dsh 鍚姩鑰岄潪
      // 寮€鏈鸿嚜鍚?. Delayed + detached + never throws: boot stays instant and
      // a broken sidecar command can never take the harness down.
      setTimeout(() => {
        try {
          ensureSidecarsFollowDsh()
        } catch {
          // impossible by contract; belt and braces
        }
      }, 3000).unref?.()
    })
  }

  // Lazily build the framework-free bridge core once a tool registry exists.
  // Returns null while the registry is absent; callers stay retry-capable.
  _bridge() {
    if (this._core) return this._core
    let tools = null
    try {
      tools = typeof this.ctx.get === 'function' ? this.ctx.get('tools') : null
    } catch {
      tools = null
    }
    if (!tools || typeof tools.register !== 'function') return null
    const self = this
    this._core = createBridgeCore({
      tools,
      createClient(cfg) {
        if (self._liteFactory) return self._liteFactory(cfg)
        return cfg.transport === 'stdio' ? new McpLiteStdio(cfg) : new McpLiteHttp(cfg)
      },
      onToolError(serverName, message) {
        self._lazyErrors.set(serverName, message)
      },
    })
    return this._core
  }

  _applyConfiguredServers() {
    const bridge = this._bridge()
    if (!bridge) return
    const { servers } = normalizeServers(readState())
    for (const s of servers) {
      if (s.mode === 'off') continue // switched off 鈥?register nothing
      if (bridge.clients.has(s.serverName)) continue
      const cfg = Object.assign({ serverName: s.serverName }, s.config)
      Promise.resolve(bridge.apply(cfg, s.mode)).catch((e) => {
        this._lazyErrors.set(s.serverName, e && e.message ? e.message : String(e))
      })
    }
  }

  _ensureAllBridges(force = false) {
    if (this._lazyTouched && !force) return
    this._lazyTouched = true
    this._applyConfiguredServers()
  }

  // 鈹€鈹€ server-mode configuration (v0.2) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  getLazy() {
    this._ensureAllBridges()
    const bridge = this._core
    const st = readState()
    const { servers } = normalizeServers(st)
    return jsonSafe({
      servers,
      legacyLazyServers: st.lazyServers || [],
      modes: bridge ? Object.fromEntries(bridge.modes) : {},
      active: bridge ? [...bridge.clients.keys()] : [],
      errors: Object.fromEntries(this._lazyErrors),
      setupError: this._lazySetupError || null,
    })
  }

  // The v0.2 control plane: switch one MCP server between full / lazy / off
  // and re-mount its bridge immediately (in-process, no restart). Native
  // loader rows for gateway-managed servers stay pinned disabled so a future
  // boot can never double-serve a namespace (bridge + blocking client).
  async setServerMode(input) {
    input = input || {}
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    const serverNameIn = typeof input.serverName === 'string' ? input.serverName.trim() : ''
    const mode = assertMode(input.mode)
    if (id === '' && serverNameIn === '') throw new Error('missing mcp row id or serverName')
    if (mode !== 'off' && input.confirm !== true) {
      throw new Error(`鍒囨崲鍒?${mode} 闇€瑕佹樉寮忕‘璁わ紙full/lazy 鐨?schema 淇濈湡搴︿笉鍚岋級`)
    }

    let serverName = serverNameIn
    let config = null
    let located = null
    const wantId = id === '' ? '' : id.replace(/^mcp-/, '')
    const stored = normalizeServers(readState()).servers.find(
      (s) => s.serverName === serverNameIn || (wantId !== '' && s.serverName === wantId)
    )
    if (stored) config = stored.config
    // M5 layer routing: the row may live in a preset or manifest rather than
    // the profile patch; resolve it anywhere before declaring it missing.
    if (!located && id !== '') located = findMcpEntryAnywhere(id, process.cwd())
    if (!located && serverNameIn !== '') located = findMcpEntryAnywhere(serverNameIn, process.cwd())
    if (!config && located && located.config) {
      config = located.config
      if (serverName === '') serverName = located.serverName || id.replace(/^mcp-/, '')
    }
    if (serverName === '' && located && located.serverName) serverName = located.serverName
    if (mode !== 'off' && !config) throw new Error(`鏈壘鍒?MCP 琛岋細${id || serverName}`)
    if (serverName === '') serverName = id.replace(/^mcp-/, '')

    const st = readState()
    const { servers } = normalizeServers(st)
    // 'off' KEEPS the entry (with its config when known): a switched-off row
    // stays gateway-managed so re-enabling never falls back to the native
    // blocking client.
    const prev = servers.find((s) => s.serverName === serverName)
    const entry =
      mode === 'off'
        ? { serverName, mode: 'off', ...(prev && prev.config ? { config: prev.config } : {}) }
        : { serverName, mode, config }
    const nextList = [...servers.filter((s) => s.serverName !== serverName), entry]
    writeState(withServers(st, nextList))

    // v0.2.2 fix: once a row is gateway-managed its NATIVE loader row stays
    // pinned disabled in EVERY mode (full / lazy / off) 鈥?that is the published
    // contract ("鍘熺敓琛屾案涔呴拤鎵庣鐢?, fast boots regardless of mode). The old
    // `mode !== 'off'` expression un-pinned the row on 'off', so after a
    // restart the native blocking client came back and could stall boot again.
    //
    // M5 refinement: only rows whose native definition lives IN this web
    // patch get pinned; preset/manifest-origin ids must not accumulate junk
    // toggle entries here.
    let pinNote = null
    if (id !== '') {
      const pinEligible =
        !!located && located.locationKind === 'patch' && located.source !== 'home-patch'
      if (pinEligible) setServerDisabled(this._patchPath(), id, true)
      else pinNote = `id銆?{id}銆嶇殑鍘熺敓瀹氫箟涓嶅湪 web 琛ヤ竵灞傦紝璺宠繃閽夋墡`
    }
    const out = this._applySingle(serverName)
    if (pinNote) out.pinNote = pinNote
    return out
  }

  // Tear down any live generation of one server, then re-apply its persisted
  // mode immediately. Never throws 鈥?errors surface through getLazy().
  _applySingle(serverName) {
    const bridge = this._bridge()
    if (!bridge) {
      // Registry not ready yet 鈥?persistence already happened; the boot
      // microtask or the next list()/getLazy() call will mount it.
      this._lazyTouched = false
      return jsonSafe({ ok: true, serverName, pendingRetry: true })
    }
    try {
      bridge.teardown(serverName)
    } catch (e) {
      this._lazyErrors.set(serverName, e && e.message ? e.message : String(e))
    }
    this._lazyErrors.delete(serverName)
    this._lazyTouched = false
    this._ensureAllBridges(true)
    return jsonSafe({
      ok: true,
      serverName,
      note: '宸插嵆鏃剁敓鏁堬紙缃戝叧鎵樼妯″紡锛屾棤閲嶅惎锛夛紱鍘熺敓缁勫悎琛屼繚鎸佺鐢?,
      modes: Object.fromEntries(bridge.modes),
    })
  }

  // Legacy shims 鈥?kept so older UI builds keep working.
  enableLazy(input) {
    return this.setServerMode({ ...input, mode: 'lazy' })
  }

  disableLazy(input) {
    input = input || {}
    const serverName = typeof input.serverName === 'string' ? input.serverName.trim() : ''
    if (serverName === '') throw new Error('missing serverName')
    return this.setServerMode({ serverName, mode: 'off', confirm: true })
  }


  ping() {
    return { ok: true, plugin: 'dsh-extension-manager', version: VERSION }
  }

  list(input) {
    input = input || {}
    const folder = process.cwd()
    this._ensureAllBridges()
    const all = listAll(folder)
    // Merge the official ctx.skills registry so provider-registered skills
    // (not on any filesystem root) are visible too 鈥?read-only entries.
    const mergeRegistry = (registrySkills) => {
      const seen = new Set(all.skills.map((s) => s.name))
      // Defensive: a registry returning any truthy non-array must degrade to
      // "no extra skills", never crash the shared `list` RPC.
      const incoming = Array.isArray(registrySkills) ? registrySkills : []
      for (const s of incoming) {
        const name = s && typeof s.name === 'string' ? s.name : null
        if (!name || seen.has(name)) continue
        seen.add(name)
        all.skills.push({
          kind: 'skill',
          name,
          description: typeof s.description === 'string' ? s.description : '',
          enabled: true,
          userInvocable: !(s.invocation && s.invocation.userInvocable === false),
          scope: 'registry',
          source: 'provider',
          path: '',
          hasBody: true,
          readOnly: true,
        })
      }
      all.skills.sort((a, b) => a.name.localeCompare(b.name))
      return jsonSafe({ skills: all.skills, mcp: all.mcp })
    }
    try {
      const reg = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('skills') : null
      if (reg && typeof reg.list === 'function') {
        const res = reg.list({ cwd: folder })
        if (res && typeof res.then === 'function') {
          return Promise.resolve(res).then((arr) => mergeRegistry(arr)).catch(() => jsonSafe({ skills: all.skills, mcp: all.mcp }))
        }
        return mergeRegistry(res)
      }
    } catch {
      // registry unavailable 鈥?filesystem listing still stands
    }
    return jsonSafe({ skills: all.skills, mcp: all.mcp })
  }

  // 鈹€鈹€ Skills 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  getSkill(input) {
    input = input || {}
    return jsonSafe(readSkill(input.name, input.scope || 'global', process.cwd()))
  }

  // Read-only skills live in shipped presets or generated preset layers; the
  // manager only edits user roots. Guard every mutating skill method.
  _assertSkillWritable(name, scope, folder) {
    const hit = listSkills(folder).find((s) => s.name === name && s.scope === scope)
    if (hit && hit.readOnly) {
      throw new Error(`鎶€鑳?"${name}" 鏉ヨ嚜鍙灞?${hit.source})锛屼笉鑳界洿鎺ヤ慨鏀广€傝鍦ㄧ敤鎴风洰褰曟柊寤哄悓鍚嶆妧鑳姐€俙)
    }
  }

  createSkill(input) {
    input = input || {}
    return createSkill(input, input.scope || 'global', process.cwd())
  }

  updateSkill(input) {
    input = input || {}
    this._assertSkillWritable(input.name, input.scope || 'global', process.cwd())
    return updateSkill(input.name, input, input.scope || 'global', process.cwd())
  }

  removeSkill(input) {
    input = input || {}
    this._assertSkillWritable(input.name, input.scope || 'global', process.cwd())
    return { removed: removeSkill(input.name, input.scope || 'global', process.cwd()) }
  }

  toggleSkill(input) {
    input = input || {}
    this._assertSkillWritable(input.name, input.scope || 'global', process.cwd())
    return toggleSkill(input.name, input.scope || 'global', !!input.disabled, process.cwd())
  }

  // 鈹€鈹€ MCP servers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  getMcp(input) {
    input = input || {}
    // M5 layer routing: resolve across home/presets/manifest too.
    return jsonSafe(findMcpEntryAnywhere(String(input.id || ''), process.cwd()))
  }

  upsertMcp(input) {
    input = input || {}
    if (!input || (!input.serverName && !input.id)) throw new Error('MCP server requires a serverName or id')
    // Safety gate: refuse ids that would collide with another layer's insert
    // rows (duplicate loader entry id = dsh web fails to boot).
    const candidateId = String(input.id || input.serverName || '')
    const gate = assertInsertIdAvailable({
      id: candidateId.startsWith('mcp-') ? candidateId : 'mcp-' + candidateId,
      ignoreFile: path.join(dshHome(), 'profiles', 'web', 'cordis.patch.yml'),
      profileDir: profileDir(),
      dshHome: dshHome(),
    })
    if (!gate.ok) throw new Error(gate.problem)
    return upsertMcp(input, input.scope || 'global', process.cwd())
  }

  removeMcp(input) {
    input = input || {}
    const result = removeMcp(input.id || input.name, input.scope || 'global', process.cwd())
    // v0.2 hygiene: a deleted row that was gateway-managed must leave the
    // persisted mode list AND have any live bridge generation torn down,
    // otherwise stale stubs/state would outlive the row.
    try {
      const rawId = String(input.id || input.name || '')
      const wantId = 'mcp-' + String(rawId).replace(/^mcp-/, '')
      const st = readState()
      const { servers } = normalizeServers(st)
      let purgedName = null
      const kept = servers.filter((s) => {
        const isTarget = 'mcp-' + s.serverName === wantId
        if (isTarget) purgedName = s.serverName
        return !isTarget
      })
      if (purgedName) {
        writeState(withServers(st, kept))
        if (this._core) this._core.teardown(purgedName)
      }
    } catch {
      // best-effort cleanup 鈥?the row removal itself already succeeded
    }
    return jsonSafe(result)
  }

  toggleMcp(input) {
    input = input || {}
    const raw = String(input.id || input.name || '').trim()
    if (raw === '') throw new Error('missing mcp row id')
    const id = raw.startsWith('mcp-') ? raw : 'mcp-' + raw
    // v0.1 bug fixed here: the client omitted `disabled`, so host computed
    // !!undefined === false and ALWAYS wrote disabled:false. Now: an explicit
    // boolean wins; without one we flip the row's CURRENT persisted state.
    const currentDisabled = toggleMap(this._patchPath())[id] === true
    const disabled =
      typeof input.disabled === 'boolean' ? input.disabled : !currentDisabled
    return toggleMcpGlobal(id, disabled)
  }

  // Read-only MCP initialize handshake (http fetch or short-lived stdio child).
  probeMcp(input) {
    input = input || {}
    return jsonSafe(probeMcpById(input.id || input.name, process.cwd()))
  }

  // Registry lookup for pip/npx-backed servers. Reports versions and the
  // exact upgrade command; never executes installs.
  checkMcpUpdate(input) {
    input = input || {}
    return jsonSafe(checkMcpUpdateById(input.id || input.name, process.cwd()))
  }

  // 鈹€鈹€ Git 浠撳簱 tab锛堝彧璇婚泦鎴愶細娴忚 + 瀹夎锛屾棤杩滅鍐欐搷浣滐級鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  //
  // 璇诲彇浼樺厛澶嶇敤鐢ㄦ埛宸茶繛鎺ョ殑 Github MCP 宸ュ叿锛堥浂棰濆鍑嵁銆侀厤棰濊蛋 MCP 鏈嶅姟绔級锛?  // 涓嶅彲鐢ㄦ椂鑷姩鍥為€€鍒板尶鍚?鐜浠ょ墝 REST銆?
  _ghBridge() {
    if (!this.__gh) this.__gh = createGitHubBridge(this.ctx)
    return this.__gh
  }

  async gitRepos(input) {
    input = input || {}
    try {
      const bridge = this._ghBridge()
      if (bridge.available()) {
        const repos = await bridge.listReposByUser(input.user)
        return jsonSafe({ ok: true, repos, via: 'mcp' })
      }
    } catch {
      // fall through to REST
    }
    try {
      return jsonSafe({ ok: true, repos: await listUserRepos(input.user), via: 'rest' })
    } catch (error) {
      return jsonSafe({ ok: false, message: error && error.message ? error.message : String(error) })
    }
  }

  async gitBrowse(input) {
    input = input || {}
    const repo = typeof input.repo === 'string' ? input.repo.trim() : ''
    const ref = (typeof input.ref === 'string' && input.ref.trim() !== '' ? input.ref.trim() : 'main')
    if (!repo || !repo.includes('/')) return jsonSafe({ ok: false, message: 'missing repo (owner/name)' })
    let units = null
    let via = null
    try {
      const bridge = this._ghBridge()
      if (bridge.available()) {
        setRepoNameHint(repo.split('/')[1] || '')
        units = await detectRepoUnitsWithLister(
          (dir) => bridge.listDir(repo, ref, dir),
          (p) => bridge.readFileText(repo, ref, p)
        )
        via = 'mcp'
      }
    } catch {
      units = null
    }
    if (!units) {
      const gh = await import('./github.mjs')
      units = await detectRepoUnitsWithLister(
        (dir) => gh.listContents(repo, ref, dir),
        (p) => fetchRawFile(repo, ref, p)
      )
      via = 'rest'
    }
    return jsonSafe({ ok: true, ...units, ref, via })
  }

  async gitInstallSkill(input) {
    input = input || {}
    try {
      let text = null
      try {
        const bridge = this._ghBridge()
        if (bridge.available()) text = await bridge.readFileText(input.repo, input.ref || 'main', input.path)
      } catch {
        text = null
      }
      if (text !== null) {
        // Shared installer body 鈥?identical exists/force semantics and the
        // same atomic writer as the REST fallback below (this used to be a
        // hand-rolled copy with its own tmp+rename).
        const guess = String(input.path || '').split('/').filter(Boolean)
        const guessed = guess.length >= 2 ? guess[guess.length - 2] : null
        const r = installSkillTextToUserRoot({
          name: input.name || guessed || '',
          text,
          force: input.force === true,
        })
        if (r.invalidName) throw new Error('鏃犳硶浠庤矾寰勬帹瀵兼妧鑳藉悕')
        return jsonSafe(r)
      }
      const r = await installSkillFromRepo({
        repo: input.repo,
        ref: input.ref || 'main',
        filePath: input.path,
        suggestedName: input.name,
        force: input.force === true,
      })
      return jsonSafe(r)
    } catch (error) {
      return jsonSafe({ ok: false, message: error && error.message ? error.message : String(error) })
    }
  }

  async gitInstallPlugin(input) {
    input = input || {}
    const repo = typeof input.repo === 'string' ? input.repo.trim() : ''
    if (!repo || !repo.includes('/')) throw new Error('missing repo (owner/name)')
    const subdir = typeof input.subdir === 'string' && input.subdir.trim() !== '' ? input.subdir.trim() : undefined
    // 澶嶇敤绉绘鐨?GitHub 鍏嬮殕瀹夎閾捐矾锛堥浂渚濊禆鏍￠獙銆佹敞鍐岃ˉ涓佽銆侀噸鍚彁绀猴級锛?    // 鏀寔瀛愮洰褰?monorepo 甯冨眬銆?    return jsonSafe(await gitInstallPlugin(profileDir(), repo, subdir))
  }



  // Live-ish MCP status snapshot from the loader tree: every mounted
  // dsh-mcp-client entry with its fiber phase. Read-only; degrades to an
  // empty list when no loader service is present. The browser sidebar polls
  // this every ~15s.
  mcpStatus() {
    const servers = []
    let error = null
    this._ensureAllBridges()
    try {
      const loader = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('loader') : null
      if (loader) {
        for (const entry of loader.entries()) {
          const name = entry && entry.options ? String(entry.options.name || '') : ''
          if (!name.includes('dsh-mcp-client')) continue
          let serverName = null
          try {
            const cfg = entry.options.config
            serverName = cfg && cfg.serverName ? String(cfg.serverName) : null
          } catch {
            // config unreadable 鈥?report the row anyway
          }
          servers.push({
            id: String(entry.id),
            serverName,
            enabled: !entry.disabled,
            phase: FIBER_PHASE[entry.fiber === undefined ? undefined : entry.fiber.state] || (entry.disabled ? 'disabled' : 'unknown'),
          })
        }
      }
    } catch (e) {
      error = e && e.message ? e.message : String(e)
    }
    return jsonSafe({ servers, error })
  }

  // 鈹€鈹€ hot-reload experiment switch 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  //
  // The dsh-web-app bundle disables the shared cordis-plugin-hmr row
  // (`disabled: true`, upstream TODO: "Re-enable shared HMR for Web after its
  // reload lifecycle is tested"). A later composition layer may override that
  // row. This switch writes/removes an `{id: hmr}` toggle in OUR managed
  // region of the profile patch 鈥?nothing else. Default stays OFF.
  _patchPath() {
    return path.join(dshHome(), 'profiles', 'web', 'cordis.patch.yml')
  }

  getHotReload() {
    const map = toggleMap(this._patchPath())
    // Effective only when our layer explicitly says disabled:false; anything
    // else keeps the upstream default (off).
    return jsonSafe({ enabled: map.hmr === false })
  }

  setHotReload(input) {
    input = input || {}
    // Confirmation gates only ENABLING (the risky direction). Disabling must
    // always be frictionless so users can back out at any time.
    if (input.enabled === true && input.confirm !== true) {
      throw new Error('寮€鍚儹閲嶈浇闇€瑕佹樉寮忕‘璁わ紙涓婃父鏈厖鍒嗛獙璇?Web 绔?HMR锛岄闄╄嚜鎷咃級')
    }
    if (input.enabled === true) {
      setServerDisabled(this._patchPath(), 'hmr', false)
    } else {
      removeServer(this._patchPath(), 'hmr')
    }
    return jsonSafe({ ok: true, enabled: input.enabled === true, pendingRestart: true })
  }


  // Loader-tree snapshot with three-tier protection labels. In production
  // `this.ctx` carries the loader service; without it this degrades to an
  // empty list rather than throwing.
  listPlugins() {
    let snap
    try {
      snap = pluginSnapshot(this.ctx, profileDir())
    } catch (error) {
      return jsonSafe({ plugins: [], error: error && error.message ? error.message : String(error) })
    }
    // Effective-config snapshot straight from live loader entries 鈥?the same
    // view harness's own plugin list shows, integrated per row.
    const cfgByEntry = new Map()
    try {
      const loader = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('loader') : null
      if (loader) {
        for (const entry of loader.entries()) {
          if (!entry || !entry.options) continue
          const raw = entry.options.config
          if (!raw || typeof raw !== 'object') continue
          const clean = {}
          for (const k of Object.keys(raw)) {
            const v = raw[k]
            if (typeof v !== 'function') clean[k] = v
          }
          cfgByEntry.set(String(entry.id), clean)
        }
      }
    } catch {
      // config enhancement is optional
    }
    const plugins = (snap.plugins || []).map((p) => {
      const cfg = cfgByEntry.get(String(p.entryId)) || null
      return Object.assign({}, p, { tier: pluginTier(p), cfg: cfg ? jsonSafe(cfg) : null })
    })
    return jsonSafe({ plugins })
  }

  _pluginTierByEntryId(entryId) {
    const want = bareEntryId(entryId)
    try {
      const snap = pluginSnapshot(this.ctx, profileDir())
      const hit = (snap.plugins || []).find((p) => bareEntryId(p.entryId) === want)
      return hit ? pluginTier(hit) : 'free'
    } catch {
      return 'free'
    }
  }

  // Enable/disable one plugin row via a managed-region toggle. Locked rows
  // are refused before any bytes move; everything else needs a restart.
  setPluginEnabled(input) {
    input = input || {}
    const rawId = typeof input.id === 'string' ? input.id.trim() : ''
    if (rawId === '') throw new Error('missing plugin id')
    const id = bareEntryId(rawId)
    const gate = this._qualityGate(id, { requireResolvable: false })
    if (gate.problems.some((p) => p.includes('宸查攣瀹?))) {
      throw new Error(`鎻掍欢銆?{id}銆嶆槸绯荤粺鍏抽敭缁勪欢锛屽凡閿佸畾锛屼笉鍏佽鍋滅敤鎴栧惎鐢╜)
    }
    // The confirm-tier note ("浠呭厑璁稿仠鐢紝涓嶅厑璁稿嵏杞?) is informational for
    // UNINSTALL; disabling a confirm-tier row is exactly what we allow here.
    const blocking = gate.problems.filter((p) => !p.includes('涓嶅厑璁稿嵏杞?))
    if (!input.enabled && blocking.length > 0) {
      throw new Error(`璐ㄩ噺闂ㄦ湭閫氳繃锛?{blocking.join('锛?)}`)
    }
    const patchPath = this._patchPath()
    if (input.enabled) removeServer(patchPath, id)
    else setServerDisabled(patchPath, id, true)
    return jsonSafe({ ok: true, pending: true, id, tier: gate.tier })
  }

  // 鈹€鈹€ quality gate 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  //
  // Pre-flight checks before mutating a third-party plugin row. All checks
  // are deterministic and read-only:
  //   1. row presence      鈥?the id must exist somewhere visible
  //   2. self-protection   鈥?locked rows never pass
  //   3. module resolvability 鈥?for npm/file rows, the entry must resolve from
  //      the web profile; a plugin whose entry cannot resolve would fail loud
  //      at next boot when referenced by a patch layer.
  _qualityGate(entryId, { requireResolvable = true } = {}) {
    const problems = []
    const tier = this._pluginTierByEntryId(entryId)
    if (tier === 'locked') problems.push(`銆?{entryId}銆嶆槸绯荤粺鍏抽敭缁勪欢锛屽凡閿佸畾`)
    if (tier === 'confirm') problems.push(`銆?{entryId}銆嶆槸瀹樻柟缁勪欢锛屼粎鍏佽鍋滅敤锛屼笉鍏佽鍗歌浇`)

    // Locate the row definition across visible layers.
    let row = null
    const want = bareEntryId(entryId)
    try {
      const snap = pluginSnapshot(this.ctx, profileDir())
      const hit = (snap.plugins || []).find((p) => bareEntryId(p.entryId) === want)
      if (hit && typeof hit.name === 'string' && hit.name !== '') row = hit
    } catch {
      // loader unavailable 鈥?fall through to patch-file scan below
    }
    if (!row) {
      const managed = listManaged(this._patchPath())
      for (const e of managed) {
        const inner = e && Array.isArray(e.insert) ? e.insert[0] : null
        if (inner && String(inner.id) === want) {
          row = { name: inner.name }
          break
        }
      }
    }
    if (!row) problems.push(`鍦ㄥ彲瑙佺粍鍚堝眰涓湭鎵惧埌琛屻€?{entryId}銆峘)

    // Module resolvability (best-effort, npm/file style rows only).
    if (requireResolvable && row && typeof row.name === 'string' && row.name !== '') {
      const rawName = row.name
      if (!rawName.startsWith('@deepseek-ai/')) {
        try {
          const req = createRequire(path.join(profileDir(), '__noop__.js'))
          req.resolve(rawName.endsWith('.js') ? rawName : path.join(rawName, 'package.json'))
        } catch {
          try {
            const req2 = createRequire(path.join(profileDir(), '__noop__.js'))
            req2.resolve(rawName)
          } catch {
            problems.push(`鍏ュ彛妯″潡鏃犳硶浠?web profile 瑙ｆ瀽锛?{rawName}锛堣嫢寮哄埗鍗歌浇鍚庢畫鐣欏紩鐢ㄤ細瀵艰嚧鍚姩澶辫触锛塦)
          }
        }
      }
    }
    return { ok: problems.length === 0, problems, tier }
  }

  precheckPlugin(input) {
    input = input || {}
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (id === '') throw new Error('missing plugin id')
    const gate = this._qualityGate(id, { requireResolvable: false })
    return jsonSafe(gate)
  }

  // Uninstall: delete the managed insert row from the profile patch. Bundle
  // rows are not in that file and report as such. Locked rows refuse.
  // S3 escape hatch: `force:true` waives ONLY the module-resolvability check,
  // so a plugin whose files were already deleted from disk can still be
  // uninstalled (previously a permanent trap 鈥?the gate demanded an entry
  // that no longer existed). Locked/confirm-tier and not-found problems
  // still hard-fail regardless of force.
  removePlugin(input) {
    input = input || {}
    const rawId = typeof input.id === 'string' ? input.id.trim() : ''
    if (rawId === '') throw new Error('missing plugin id')
    const id = bareEntryId(rawId)
    const gate = this._qualityGate(id, { requireResolvable: input.force !== true })
    if (gate.problems.length > 0) {
      throw new Error(`璐ㄩ噺闂ㄦ湭閫氳繃锛?{gate.problems.join('锛?)}`)
    }
    // Snapshot the managed row so the uninstall is reversible.
    let removedRow = null
    for (const e of listManaged(this._patchPath())) {
      const inner = e && Array.isArray(e.insert) ? e.insert[0] : null
      if (inner && String(inner.id) === String(id)) {
        removedRow = inner
        break
      }
    }
    const patchPath = this._patchPath()
    const result = removePluginRow(patchPath, id)
    if (!result.removed) {
      return jsonSafe({ ok: false, message: '鏈湪閰嶇疆涓壘鍒拌鎻掍欢琛岋紙鍐呯疆鎻掍欢鏃犳硶鍗歌浇锛屽彧鑳藉仠鐢級' })
    }
    try {
      writeState({ lastRemovedPlugin: removedRow ? { at: new Date().toISOString(), row: removedRow } : null })
    } catch {
      // state write failure must not fail an already-successful uninstall
    }
    // Residual report so the client can offer one-click deep cleanup:
    // home data/cache/storage dirs, the node_modules copy and the package.json
    // dependency/bundle entry all survive a config-row uninstall by design.
    let leftovers = null
    try {
      leftovers = scanPlugin({
        home: dshHome(),
        webProfileDir: profileDir(),
        name: removedRow && typeof removedRow.name === 'string' ? removedRow.name : '',
        extraNames: [id],
      })
    } catch { leftovers = null }
    return jsonSafe({
      ok: true,
      pending: true,
      id,
      undoable: !!removedRow,
      leftovers,
      message: '宸蹭粠閰嶇疆绉婚櫎锛岄噸鍚?dsh web 鍚庣敓鏁?,
    })
  }

  // Restore the most recently uninstalled plugin row from the state snapshot.
  restoreRemovedPlugin() {
    const st = readState()
    const entry = st && st.lastRemovedPlugin ? st.lastRemovedPlugin : null
    if (!entry || !entry.row || !entry.row.id) {
      return jsonSafe({ ok: false, message: '娌℃湁鍙仮澶嶇殑鍗歌浇璁板綍' })
    }
    upsertServer(this._patchPath(), entry.row)
    writeState({ lastRemovedPlugin: null })
    return jsonSafe({ ok: true, pendingRestart: true, id: entry.row.id })
  }

  // Scan every non-official plugin for a newer version (npm registry / git
  // origin HEAD). Read-only.
  async checkPluginUpdates() {
    try {
      return jsonSafe(await pluginUpdateScan(this.ctx, profileDir()))
    } catch (error) {
      return jsonSafe({ ok: false, message: error && error.message ? error.message : String(error) })
    }
  }

  // Update one third-party plugin by package/repo name.
  async updateOnePlugin(input) {
    input = input || {}
    const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : ''
    if (name === '') throw new Error('missing plugin name')
    const gate = this._qualityGate(name, { requireResolvable: false })
    if (gate.problems.some((p) => p.includes('宸查攣瀹?))) {
      throw new Error(`鎻掍欢銆?{name}銆嶆槸绯荤粺鍏抽敭缁勪欢锛屼笉鍏佽鏇存柊鎿嶄綔`)
    }
    return jsonSafe(await updatePluginItem(profileDir(), name))
  }

  // 鈹€鈹€ residual cleanup (uninstall leftovers) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  // Read-only residual report for one plugin, by row id and/or package name.
  pluginLeftovers(input) {
    input = input || {}
    const id = bareEntryId(typeof input.id === 'string' ? input.id : '')
    let name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name && id) {
      try {
        const snap = pluginSnapshot(this.ctx, profileDir())
        const hit = (snap.plugins || []).find((p) => bareEntryId(p.entryId) === id)
        if (hit && hit.name) name = hit.name
      } catch { /* read-only best effort */ }
    }
    if (!name && !id) throw new Error('missing plugin id/name')
    const scan = scanPlugin({
      home: dshHome(),
      webProfileDir: profileDir(),
      name,
      extraNames: [id],
    })
    return jsonSafe({ ok: true, ...scan })
  }

  // Orphan scan: directories under the DSH home that belong to no live
  // plugin 鈥?the "health check" for plugins uninstalled before this feature
  // existed (dsh-pocket, dsh-extension-hub, ...).
  scanOrphanLeftovers() {
    const live = orphanScanLiveNames(this.ctx, profileDir(), this._patchPath())
    const result = scanOrphans({ home: dshHome(), liveNames: [...live] })
    return jsonSafe({ ok: true, ...result })
  }

  // Validated purge. Deletes exactly the reported directories (the client
  // echoes the scan output back), optionally plus the profile
  // node_modules/<name> copy and the package.json dependency/bundle entry of
  // one named plugin. Refuses core directories, traversal, name mismatches,
  // and artifacts of plugins still registered in the composition.
  purgePlugin(input) {
    input = input || {}
    const dirs = (Array.isArray(input.dirs) ? input.dirs : []).map((d) => String(d || '').trim()).filter((s) => s !== '')
    const id = bareEntryId(typeof input.id === 'string' ? input.id : '')
    let name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name && id) {
      try {
        const snap = pluginSnapshot(this.ctx, profileDir())
        const hit = (snap.plugins || []).find((p) => bareEntryId(p.entryId) === id)
        if (hit && hit.name) name = hit.name
      } catch { /* best effort */ }
    }
    if (dirs.length === 0 && !name && !id) throw new Error('missing purge target (dirs / id / name)')
    const live = compositionLiveNames(profileDir(), this._patchPath())
    const names = new Set()
    const pkgName = (typeof input.npmName === 'string' && input.npmName.trim() !== '') ? input.npmName.trim() : name
    if (pkgName && pkgName !== '') names.add(pkgName)
    if (id && id !== '') names.add(id)
    for (const n of names) {
      if (LOCKED_PLUGIN_NAMES.has(n) || n === 'dsh-extension-manager' || n === SELF_ENTRY_ID) {
        return jsonSafe({ ok: false, message: `Plugin銆?{n}銆峣s protected, cleanup is forbidden` })
      }
      if (!input.force && live.has(n.toLowerCase())) {
        return jsonSafe({ ok: false, message: `Plugin銆?{n}銆峣s still registered in the composition, please uninstall it first (or restart dsh web to make the uninstall take effect) before cleanup` })
      }
    }
    const result = purgeArtifacts({
      home: dshHome(),
      webProfileDir: profileDir(),
      names: [...names],
      dirs,
      removePackage: input.removePackage === true,
      removeNodeModules: input.removeNodeModules === true,
      liveNames: [...live],
      force: input.force === true,
    })
    try { writeState({ lastPurge: { at: new Date().toISOString(), result } }) } catch { /* best effort */ }
    return jsonSafe({ ok: result.ok, ...result })
  }

  // 鈹€鈹€ UI state 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  // Sidecar daemons that follow dsh web startup (config: sidecars.json).
  listSidecars() {
    return jsonSafe({ sidecars: sidecarsWithStatus() })
  }

  // Manual trigger 鈥?the same idempotent ensure that runs at activation.
  ensureSidecarsNow() {
    return jsonSafe({ results: ensureAllSidecars() })
  }

  getState() {
    return readState()
  }

  setState(input) {
    input = input || {}
    return writeState(input.patch || {})
  }
}

// Register Remote methods (declaration order = wire order).
for (const [method, exportName] of [
  ['ping', undefined],
  ['list', undefined],
  ['getSkill', undefined],
  ['createSkill', undefined],
  ['updateSkill', undefined],
  ['removeSkill', undefined],
  ['toggleSkill', undefined],
  ['getMcp', undefined],
  ['upsertMcp', undefined],
  ['removeMcp', undefined],
  ['toggleMcp', undefined],
  ['probeMcp', undefined],
  ['checkMcpUpdate', undefined],
  ['listPlugins', undefined],
  ['setPluginEnabled', undefined],
  ['removePlugin', undefined],
  ['pluginLeftovers', undefined],
  ['scanOrphanLeftovers', undefined],
  ['purgePlugin', undefined],
  ['mcpStatus', undefined],
  ['getHotReload', undefined],
  ['setHotReload', undefined],
  ['precheckPlugin', undefined],
  ['restoreRemovedPlugin', undefined],
  ['checkPluginUpdates', undefined],
  ['updateOnePlugin', undefined],
  ['getLazy', undefined],
  ['enableLazy', undefined],
  ['disableLazy', undefined],
  ['setServerMode', undefined],
  ['gitRepos', undefined],
  ['gitBrowse', undefined],
  ['gitInstallSkill', undefined],
  ['gitInstallPlugin', undefined],
  ['getState', undefined],
  ['setState', undefined],
  ['listSidecars', undefined],
  ['ensureSidecarsNow', undefined],
]) {
  markRemote(extensionManagerGateway.prototype, method, exportName)
}

export default extensionManagerGateway
