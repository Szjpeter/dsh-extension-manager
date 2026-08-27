// dsh-mcp-client requires serverName to match [A-Za-z0-9_-]{1,32}.
export function normalizeServerName(name) {
  let s = String(name || '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s === '') s = 'mcp-server'
  if (/^[0-9]/.test(s)) s = 'm-' + s
  return s.slice(0, 32)
}

// Convert a discovered MCP item into a dsh-mcp-client config object.
// (v0.2.2 slimming: mcpItemToInsertEntry / skillItemToSkillMd were removed —
// zero references since the git-skill installer was unified and project-preset
// rows moved onto the region pipeline.)
export function mcpItemToConfig(item) {
  const serverName = normalizeServerName(item.name)
  if (item.transport === 'streamable-http') {
    const config = { serverName, transport: 'streamable-http', url: item.url || '' }
    if (item.headers && Object.keys(item.headers).length) config.headers = item.headers
    return { serverName, config, id: 'mcp-' + serverName }
  }
  const config = { serverName, transport: 'stdio', command: item.command || '' }
  if (item.args && item.args.length) config.args = item.args
  if (item.env && Object.keys(item.env).length) config.env = item.env
  return { serverName, config, id: 'mcp-' + serverName }
}
