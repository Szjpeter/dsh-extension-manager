// Bridge that reuses the USER'S already-connected GitHub MCP tools
// (e.g. mcp-Github → api.githubcopilot.com) instead of anonymous REST.
//
// Why: zero extra credentials, quota is consumed by the authenticated MCP
// server (5000+/h), private repos work. Every call goes through the official
// ctx.tools registry; if the tools/service are unavailable we report that and
// callers fall back to direct REST.

const TOOL_FILE = 'mcp__Github__get_file_contents'
const TOOL_SEARCH = 'mcp__Github__search_repositories'

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Depth-limited search for the first array that looks like a payload list.
function findArray(node, depth = 0) {
  if (depth > 4) return null
  if (Array.isArray(node)) {
    if (node.length === 0) return node
    return node
  }
  if (!isObj(node)) return null
  for (const key of ['entries', 'contents', 'items', 'plugins', 'repos', 'data', 'value', 'result']) {
    if (node[key] !== undefined) {
      const found = findArray(node[key], depth + 1)
      if (found) return found
    }
  }
  for (const key of Object.keys(node)) {
    const found = findArray(node[key], depth + 1)
    if (found && Array.isArray(found) && found.length) return found
  }
  return null
}

function decodeMaybeBase64(obj) {
  // GitHub contents API shape: { content, encoding } | { text } | plain string
  if (typeof obj === 'string') return obj
  if (isObj(obj)) {
    if (typeof obj.text === 'string' && obj.text !== '') return obj.text
    if (typeof obj.content === 'string') {
      if ((obj.encoding || '') === 'base64') {
        try {
          return Buffer.from(obj.content.replace(/\s+/g, ''), 'base64').toString('utf8')
        } catch {
          /* fallthrough */
        }
      }
      return obj.content
    }
  }
  return null
}

export function createGitHubBridge(ctx) {
  function toolsSvc() {
    try {
      const t = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : null
      if (t && typeof t.get === 'function' && typeof t.execute === 'function') return t
    } catch {
      /* not composed */
    }
    return null
  }

  function available() {
    const t = toolsSvc()
    if (!t) return false
    try {
      return !!t.get(TOOL_FILE)
    } catch {
      return false
    }
  }

  async function callTool(name, args) {
    const t = toolsSvc()
    if (!t) throw new Error('tools service unavailable')
    const res = await t.execute({
      callId: 'exm-git-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
      name,
      arguments: args || {},
      signal: undefined,
    })
    if (res && res.isError) {
      throw new Error((res.error && res.error.message) || ('tool error: ' + name))
    }
    return res ? res.value : undefined
  }

  async function listDir(repoFullName, ref, dirPath) {
    const slash = repoFullName.indexOf('/')
    const owner = repoFullName.slice(0, slash)
    const repo = repoFullName.slice(slash + 1)
    const value = await callTool(TOOL_FILE, { owner, repo, path: dirPath || '', ref: ref || undefined })
    const arr = findArray(value)
    return (arr || [])
      .filter((e) => isObj(e) && e.name !== undefined)
      .map((e) => ({
        name: String(e.name),
        path: String(e.path !== undefined ? e.path : (dirPath ? dirPath + '/' + e.name : e.name)),
        type: String(e.type || (e.kind === 'directory' ? 'dir' : 'file')),
      }))
  }

  async function readFileText(repoFullName, ref, filePath) {
    const slash = repoFullName.indexOf('/')
    const owner = repoFullName.slice(0, slash)
    const repo = repoFullName.slice(slash + 1)
    const value = await callTool(TOOL_FILE, { owner, repo, path: filePath, ref: ref || undefined })
    // locate a decodable text within the value
    const queue = [value]
    for (let guard = 0; guard < 50 && queue.length; guard++) {
      const node = queue.shift()
      const text = decodeMaybeBase64(node)
      if (typeof text === 'string' && text !== '') return text
      if (isObj(node)) {
        for (const k of Object.keys(node)) queue.push(node[k])
      } else if (Array.isArray(node)) {
        queue.push(...node)
      }
    }
    throw new Error('无法从工具结果中解码文件内容')
  }

  async function listReposByUser(user) {
    const me = await callTool('mcp__Github__get_me', {}).catch(() => null)
    const login = me && me.login
      ? me.login
      : (me && me.value && me.value.login) || String(user || '').trim()
    const value = await callTool(TOOL_SEARCH, {
      query: 'user:' + login + ' sort:updated',
      perPage: 100,
      page: 1,
    })
    const arr = findArray(value) || []
    return arr
      .filter((r) => isObj(r))
      .map((r) => ({
        fullName: r.full_name || r.fullName || (login + '/' + r.name),
        name: r.name,
        description: r.description || '',
        defaultBranch: r.default_branch || r.defaultBranch || 'main',
        updatedAt: r.updated_at || r.updatedAt || '',
        isFork: !!r.fork,
      }))
  }

  return { available, callTool, listDir, readFileText, listReposByUser }
}
