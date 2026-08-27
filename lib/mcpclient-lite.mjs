// Minimal MCP client used by the lazy-loading bridge.
//
// Unlike a probe (one-shot initialize), this client stays connected:
//   - stdio : one persistent child process, newline-delimited JSON-RPC
//   - http  : streamable-http POSTs; captures Mcp-Session-Id when the server
//             issues one and replays it on subsequent calls
//
// Deliberately minimal: initialize → notifications/initialized → tools/list
// → tools/call. Nothing else. All methods reject after PROBE_TIMEOUT_MS.
import { spawn } from 'node:child_process'

const TIMEOUT_MS = 15000

function rpcRequest(id, method, params) {
  return { jsonrpc: '2.0', id, method, params }
}

// G1: across multi-frame SSE bodies chatty servers prepend progress/logging
// notifications before the real reply — always prefer the frame echoing OUR
// request id over the first result-bearing frame.
function pickSseMessage(raw, wantId) {
  let fallback = null
  for (const line of String(raw).split('\n')) {
    const s = line.trim()
    if (!s.startsWith('data:')) continue
    let msg
    try {
      msg = JSON.parse(s.slice(5).trim())
    } catch {
      continue
    }
    if (!msg || typeof msg !== 'object') continue
    if (wantId != null && msg.id !== undefined && String(msg.id) === String(wantId)) return msg
    if (!fallback && (msg.result || msg.error || msg.id !== undefined)) fallback = msg
  }
  return fallback
}

class HttpLite {
  constructor(cfg) {
    this.url = cfg.url
    this.headers = cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {}
    this.sessionId = null
    this.nextId = 1
  }

  async post(message) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const headers = Object.assign(
        {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        this.headers
      )
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const raw = await res.text()
      if (raw === '') return null // accepted notification, no body
      try {
        return JSON.parse(raw)
      } catch {
        return pickSseMessage(raw, message && message.id != null ? message.id : null)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async initialize() {
    const msg = await post0(this, rpcRequest(this.nextId++, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-extension-manager-lazy', version: '0.1.0' },
    }))
    if (!msg || !msg.result) throw new Error('initialize handshake failed')
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return msg.result
  }

  async request(method, params) {
    const msg = await post0(this, rpcRequest(this.nextId++, method, params))
    if (!msg) throw new Error(`${method}: empty response`)
    if (msg.error) throw new Error(`${method}: ${msg.error.message || 'error'}`)
    return msg.result
  }

  async close() {
    /* stateless http — nothing to release */
  }
}

// post0 tolerates a null reply for notifications by re-using post(); kept as
// a shim so initialize() reads clearly.
async function post0(client, message) {
  return client.post(message)
}

export class McpLiteHttp extends HttpLite {}

export class McpLiteStdio {
  constructor(cfg) {
    this.command = cfg.command
    this.args = Array.isArray(cfg.args) ? cfg.args : []
    this.env = cfg.env && typeof cfg.env === 'object' ? cfg.env : {}
    this.cwd = typeof cfg.cwd === 'string' && cfg.cwd !== '' ? cfg.cwd : undefined
    this.child = null
    this.buffer = ''
    this.pending = new Map()
    this.nextId = 1
    this.closed = false
  }

  _start() {
    if (this.child) return
    this.child = spawn(this.command, this.args, {
      env: Object.assign({}, process.env, this.env),
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk) => this._onData(String(chunk)))
    this.child.on('exit', () => this._rejectAll('server process exited'))
    this.child.on('error', () => this._rejectAll('server process error'))
  }

  _onData(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.startsWith('{')) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        resolve(msg)
      }
    }
  }

  _rejectAll(reason) {
    for (const { reject } of this.pending.values()) reject(new Error(reason))
    this.pending.clear()
  }

  _send(message) {
    this._start()
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  _request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timeout after ${TIMEOUT_MS}ms`))
      }, TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer)
          if (msg.error) reject(new Error(`${method}: ${msg.error.message || 'error'}`))
          else resolve(msg.result)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        this._send(rpcRequest(id, method, params))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async initialize() {
    this._start()
    const result = await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-extension-manager-lazy', version: '0.1.0' },
    })
    this._send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return result
  }

  async request(method, params) {
    return this._request(method, params)
  }

  async close() {
    this.closed = true
    this._rejectAll('client closed')
    try {
      if (this.child && this.child.exitCode === null) this.child.kill()
    } catch {
      // already gone
    }
    this.child = null
  }
}
