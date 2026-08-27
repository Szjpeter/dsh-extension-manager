# Issue draft 1 → deepseek-ai/deepseek-harness

**Title:** dsh-mcp-client: support deferred/non-blocking connection modes (`connectOn: boot | firstUse | manual`) so remote MCP servers never delay host startup

## Summary

Today every MCP server declared as a `@deepseek-ai/dsh-mcp-client` loader entry connects **synchronously inside plugin activation**: `resolveConfig → fiber await connection.ready`, which awaits the first `initialize` + paginated `tools/list` before registration completes.

Because the web surface prints its readiness line only after the whole composition tree settles (`dsh-web-app/lib/index.js` — `ctx.get("loader")?.await()`), a slow or unreachable remote endpoint delays host readiness by up to the SDK default timeout (60 s per request). Observed production impact on Windows desktop launch: repeated "double-spawn + EADDRINUSE exit(1)" crash loops whenever cold-start network latency exceeded the desktop launcher's readiness window (~2026-08-27 logs, 13+ cycles).

## Proposal

Expose first-class non-blocking modes on each entry config, e.g.

```yaml
- id: mcp-Github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: Github
    transport: streamable-http
    url: https://api.githubcopilot.com/mcp/
    connectOn: manual        # boot (default) | sessionStart | firstUse | manual
    failOnStartupError: false
```

* `boot` — current behavior (blocking, full schema).
* `sessionStart` / `firstUse` — register placeholder handling and connect outside the composition-critical path (fire-and-forget supervisor), swapping in real schema once ready.
* `manual` — mount nothing until an explicit API call (a runtime toggle surface can then drive it).

Also please expose a documented connection/discovery timeout (currently inherited from the SDK's 60 s default, see README limitations).

## Why not just use lazy bridges?

Community stopgaps exist (dsh-mcp-lazy, extension-manager stub bridges) but they either drop parameter schemas or reimplement tool lifecycle outside official maintenance. A small native option removes an entire class of startup races and lets UI managers govern mode switches through supported APIs instead of patch-file edits.

Happy to provide reproducible traces (boot logs, timelines) if useful.
