// Bridge-core: the framework-free state machine behind the MCP gateway.
//
// Owns one generation per serverName:
//   apply(cfg, mode)   → connect (injected client factory), discover tools,
//                        register them on the injected tool registry using
//                        full (real inputSchema) or lazy (name-only stub)
//                        fidelity, remembering disposers.
//   teardown(name)     → dispose every registration, close the client.
//
// Zero DSH dependencies on purpose: unit-testable offline with fake registries
// and scripted clients (see tests/server-modes.test.mjs).

export const SERVER_MODES = ['full', 'lazy', 'off']

// Auto-policy (v0.2.1): a server answering tools/list with MORE than this
// many tools is demoted full→lazy unless its config pins fullPreferred:true.
// Rationale: per-conversation context cost scales linearly with schemas
// (~300+ tokens/tool measured on github-mcp-server, 44 tools ≈ 12k–15k).
export const AUTO_LAZY_TOOL_THRESHOLD = 30

/**
 * Create a bridge controller.
 * @param {object} ports
 * @param {object} ports.tools - host ToolRuntime exposing register(definition)->disposer.
 * @param {(cfg:object)=>Promise|object} ports.createClient - client factory (McpLite compatible).
 * @param {(serverName:string, message:string)=>void} [ports.onToolError]
 *        Called when ONE tool fails to register; must never throw.
 */
export function createBridgeCore({ tools, createClient, onToolError }) {
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('bridge-core: tools.register is required')
  }
  if (typeof createClient !== 'function') {
    throw new Error('bridge-core: createClient factory is required')
  }

  /** serverName -> connected client instance */
  const clients = new Map()
  /** serverName -> [disposer] */
  const disposers = new Map()
  /** serverName -> mode currently served ('full'|'lazy') */
  const modes = new Map()

  /** Resolve the live client for a server, reconnecting if needed. */
  async function resolveLive(cfg) {
    let client = clients.get(cfg.serverName)
    if (!client) {
      // Reconnect lazily, re-registering with the previously served mode so
      // the public tool names stay prefix-stable across reconnects.
      await apply(cfg, modes.get(cfg.serverName) || 'lazy')
      client = clients.get(cfg.serverName)
    }
    if (!client) throw new Error(`桥未连接：${cfg.serverName}`)
    return client
  }

  async function apply(cfg, requestedMode) {
    const serverName = cfg.serverName
    const mode = SERVER_MODES.includes(requestedMode) && requestedMode !== 'off'
      ? requestedMode
      : 'lazy'

    // A namespace swap MUST tear the previous generation down first: the host
    // tool registry treats same-name registrations as a squatting conflict and
    // rolls back whole generations otherwise.
    teardown(serverName)

    const client = await Promise.resolve(createClient(cfg))
    await client.initialize()
    const list = await client.request('tools/list', {})
    const realTools = Array.isArray(list.tools) ? list.tools : []

    // v0.2.1 auto-policy — evaluated AFTER discovery, BEFORE registration, so
    // oversized schema work never happens even once for huge servers.
    let appliedMode = requestedMode === 'off' ? 'lazy' : requestedMode
    let autoDemoted = false
    if (
      appliedMode === 'full' &&
      !cfg.fullPreferred &&
      realTools.length > AUTO_LAZY_TOOL_THRESHOLD
    ) {
      appliedMode = 'lazy'
      autoDemoted = true
    }

    const registered = []
    try {
      for (const t of realTools) {
        if (!t || typeof t.name !== 'string') continue
        const publicName = `mcp__${serverName}__${t.name}`
        const isFull = appliedMode === 'full'
        const description = isFull
          ? `${t.description || t.name}`
          : `${t.description || t.name}（懒加载：参数为自由 JSON 对象）`
        const parameters = isFull
          ? (t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' })
          : {
              arguments: {
                type: 'object',
                required: false,
                description: '该工具的真实入参对象。字段以服务器定义为准；完整 schema 按需获取。',
              },
            }
        const dispose = tools.register({
          name: publicName,
          description,
          parameters,
          output: { schema: { type: 'object' } },
          execute: async (args) => {
            const payloadArguments =
              appliedMode === 'full'
                ? (args && typeof args === 'object' ? args : {})
                : ((args && args.arguments) || {})
            const attempt = () => resolveLive(cfg).then((live) =>
              live.request('tools/call', { name: t.name, arguments: payloadArguments })
            )
            let res
            try {
              res = await attempt()
            } catch (error) {
              // M6: a stdio server process dying leaves its client cached;
              // every later call would hit the dead pipe forever. Fatal
              // transport failures (process exited / spawn error / closed)
              // drop the cache so the NEXT attempt rebuilds the connection
              // while the registered stubs — and their public names — stay
              // mounted. Transient HTTP/timeouts are rethrown untouched.
              const msg = String((error && error.message) || error)
              if (!/(process exited|process error|client closed)/i.test(msg)) throw error
              clients.delete(cfg.serverName)
              res = await attempt()
            }
            // The caller may wrap results for the JSON boundary.
            return res && typeof res === 'object' ? res : { value: res }
          },
        })
        if (typeof dispose === 'function') registered.push(dispose)
      }
    } catch (error) {
      // Roll back THIS generation's partial registrations before surfacing;
      // the previous generation was already disposed, which is safe because
      // fetch phase failures mean we have nothing better to serve.
      for (const d of registered) {
        try {
          d()
        } catch {
          // best-effort rollback
        }
      }
      try {
        Promise.resolve(client.close()).catch(() => {})
      } catch {
        // ignore close errors during failure path
      }
      throw error
    }

    clients.set(serverName, client)
    disposers.set(serverName, registered)
    modes.set(serverName, appliedMode)

    return {
      count: registered.length,
      mode: appliedMode,
      tools: realTools.length,
      autoDemoted,
    }
  }

  function teardown(serverName) {
    for (const d of disposers.get(serverName) || []) {
      try {
        d()
      } catch {
        // already disposed / registry changed underneath us
      }
    }
    disposers.delete(serverName)
    const client = clients.get(serverName)
    if (client) {
      try {
        Promise.resolve(client.close()).catch(() => {})
      } catch {
        // closing twice must not throw here
      }
      clients.delete(serverName)
    }
    modes.delete(serverName)
  }

  return {
    apply,
    teardown,
    clients,
    disposers,
    modes,
    /** Per-tool failure sink kept OUT of throws by contract. */
    reportToolError(serverName, message) {
      if (typeof onToolError === 'function') onToolError(serverName, message)
    },
  }
}
