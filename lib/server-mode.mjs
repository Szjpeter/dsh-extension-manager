// Server-mode state model for the extension-manager MCP gateway (v0.2).
//
// One source of truth in state.json:
//
//   servers: [{ serverName, mode: 'full' | 'lazy', config }]
//
// `mode` decides how the gateway serves the server's tools:
//   full : connect now (async, never blocks the loader tree) and register
//          every tool with its REAL inputSchema from the server.
//   lazy : connect only enough to learn tool NAMES, then register name-only
//          stubs (free-form JSON argument). Real calls go through the bridge.
//   off  : registered nothing — kept in state so the UI switch stays stable.
//
// Backward compatibility: v0.1 persisted `lazyServers: [{serverName, config}]`.
// `normalizeServers()` migrates that shape transparently; writes always emit
// the new key and drop the old one.

export const SERVER_MODES = ['full', 'lazy', 'off']

/**
 * Merge legacy `lazyServers` into the canonical `servers` list.
 * @param state - parsed state.json content (may be undefined/null/partial).
 * @returns {{ servers: Array<{serverName:string, mode:string, config:object}> }}
 */
export function normalizeServers(state) {
  const out = []
  const seen = new Set()
  // Last-wins per serverName (mirrors loader patch merge semantics): a later
  // row describing the same server replaces an earlier description.
  const push = (serverName, mode, config) => {
    if (!serverName || typeof serverName !== 'string') return
    if (!mode || mode === 'off') {
      const hitIdx = out.findIndex((x) => x.serverName === serverName)
      const merged = { serverName, mode: 'off', ...(config && typeof config === 'object' ? { config } : {}) }
      if (hitIdx >= 0) out[hitIdx] = merged
      else {
        seen.add(serverName)
        out.push(merged)
      }
      return
    }
    if (mode !== 'full' && mode !== 'lazy') return
    if (!config || typeof config !== 'object') return
    const hitIdx = out.findIndex((x) => x.serverName === serverName)
    if (hitIdx >= 0) out[hitIdx] = { serverName, mode, config }
    else {
      seen.add(serverName)
      out.push({ serverName, mode, config })
    }
  }
  if (state && Array.isArray(state.servers)) {
    for (const s of state.servers) {
      if (!s || typeof s !== 'object') continue
      const mode = SERVER_MODES.includes(s.mode) ? s.mode : null
      if (!mode) continue
      push(s.serverName, mode, s.config)
    }
  }
  if (state && Array.isArray(state.lazyServers)) {
    for (const s of state.lazyServers) {
      if (!s || typeof s !== 'object') continue
      push(s.serverName, 'lazy', s.config ?? s)
    }
  }
  return { servers: out }
}

/** Serialize the canonical form onto a state object (drops legacy keys). */
export function withServers(stateObj, servers) {
  const next = { ...(stateObj || {}) }
  delete next.lazyServers
  delete next.servers
  next.servers = servers.map((s) =>
    s.mode === 'off'
      ? { serverName: s.serverName, mode: 'off', ...(s.config ? { config: s.config } : {}) }
      : s
  )
  return next
}

/** Validate one requested mode transition. Returns normalized mode string. */
export function assertMode(mode) {
  if (!SERVER_MODES.includes(mode)) {
    throw new Error(`invalid server mode '${String(mode)}' — expected one of ${SERVER_MODES.join(', ')}`)
  }
  return mode
}
