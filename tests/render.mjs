// Headless render test for lib/client.js — executes the plugin face against
// stub browser/React/ctx environments and walks the rendered element tree,
// so any render-time exception surfaces here instead of a blank settings page.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const code = fs.readFileSync(file, 'utf8')

// ── minimal React stub ───────────────────────────────────────────────────────
let hookState = []
let hookIndex = 0
let hookSeed = null // optional {index: value} applied at reset — lets tests exercise data-bearing renders
// Hook audit: hooks consumed per function-component invocation. React #310
// ("more hooks than previous render") fires when a component's count varies —
// e.g. a child component invoked as a plain function so its hooks leak into
// the parent sequence. We fail loudly on any variance.
let currentHookOwner = ''
const hookAudit = new Map() // owner -> [counts per invocation]
function auditBegin(owner) { currentHookOwner = owner || ''; hookIndex = 0 }
function auditEnd() {
  if (!currentHookOwner) return
  const arr = hookAudit.get(currentHookOwner) || []
  arr.push(hookIndex)
  hookAudit.set(currentHookOwner, arr)
  currentHookOwner = ''
}
function resetHooks() {
  hookState = []
  hookIndex = 0
  if (hookSeed) {
    for (const k of Object.keys(hookSeed)) {
      hookState[Number(k)] = [hookSeed[k], () => {}]
    }
  }
}
const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) }
  },
  useState(initial) {
    const i = hookIndex++
    if (hookState[i] === undefined) hookState[i] = [typeof initial === 'function' ? initial() : initial, () => {}]
    return hookState[i]
  },
  useEffect() { hookIndex++ },
  useCallback(fn) { hookIndex++; return fn },
  Component: function Component(props) { this.props = props || {} },
}
ReactStub.Component.isReactComponent = {} // what real React sets on the base class prototype

// ── browser stubs ────────────────────────────────────────────────────────────
let loaded = null
const documentStub = {
  querySelector: () => true, // pretend CSS already injected; skip DOM writes
  createElement: () => ({ dataset: {} }),
  head: { appendChild() {} },
}
const sandbox = {
  window: { __ModuleLoader__: { load(def) { loaded = def } } },
  document: documentStub,
  console,
  setTimeout,
  setInterval,
  clearInterval,
  Promise,
}
sandbox.window.confirm = () => false
vm.createContext(sandbox)

console.log('── executing module ──')
try {
  new vm.Script(code, { filename: 'client.js' }).runInContext(sandbox)
} catch (e) {
  console.log('MODULE EXECUTION THREW:', e.stack)
  process.exit(1)
}
if (!loaded) { console.log('FAIL: __ModuleLoader__.load never called'); process.exit(1) }
console.log('module id:', loaded.id)

const exports_ = loaded.factory(function require(name) {
  if (name === 'react') return ReactStub
  throw new Error('unexpected require: ' + name)
})
console.log('apply:', typeof exports_.apply, '| inject:', exports_.inject.join(','))

// ── fake ctx ─────────────────────────────────────────────────────────────────
const registeredSlots = []
const apiCalls = []
const ctx = {
  locale: { register() {}, bind() { return (k) => k } },
  remote: { async $mount() {} },
  reflect: {
    get(key) {
      const api = {}
      for (const m of ['ping', 'list', 'getSkill', 'createSkill', 'updateSkill', 'removeSkill', 'toggleSkill', 'getMcp', 'upsertMcp', 'removeMcp', 'toggleMcp', 'probeMcp', 'checkMcpUpdate', 'listPlugins', 'setPluginEnabled', 'removePlugin', 'mcpStatus', 'getHotReload', 'setHotReload', 'precheckPlugin', 'restoreRemovedPlugin', 'checkPluginUpdates', 'updateOnePlugin', 'gitRepos', 'gitBrowse', 'gitInstallSkill', 'gitInstallPlugin', 'getState', 'setState']) {
        api[m] = async (input) => {
          apiCalls.push(m)
          // canned realistic responses
          if (m === 'list') return {
            skills: [{ kind: 'skill', name: 'demo-skill', description: 'demo', enabled: true, scope: 'global', source: 'user-dsh', path: 'x', hasBody: true, readOnly: false }],
            mcp: [{ kind: 'mcp', id: 'mcp-demo', serverName: 'Demo', transport: 'streamable-http', enabled: true, scope: 'global', source: 'host-patch', location: 'x', locationKind: 'patch' }],
          }
          if (m === 'listPlugins') return { plugins: [
            { entryId: 'include', name: 'cordis:include', enabled: true, phase: 'active', official: true, core: true, tier: 'locked' },
            { entryId: 'exm', name: 'dsh-extension-manager', enabled: true, phase: 'active', official: false, core: false, tier: 'locked' },
            { entryId: 'some-plugin', name: 'dsh-cost-meter', enabled: true, phase: 'active', official: false, core: false, tier: 'free' },
          ] }
          if (m === 'getHotReload') return { enabled: false }
          return {}
        }
      }
      return key === 'remote.extensionManager' ? api : null
    },
  },
  slots: {
    inject(name, cb) {
      try {
        const reg = cb()
        registeredSlots.push({ name, reg })
      } catch (e) {
        console.log(`slots.inject(${name}) callback threw:`, e.stack)
      }
    },
    register(spec, component) {
      return { spec, component }
    },
  },
}

console.log('── apply(ctx) ──')
try {
  await exports_.apply(ctx)
} catch (e) {
  console.log('APPLY THREW:', e.stack)
  process.exit(1)
}
console.log('registered slots:', registeredSlots.map((s) => `${s.name}#${s.reg.spec.id}`).join(', '))

// ── render every tab ─────────────────────────────────────────────────────────
function renderTree(el, depth) {
  if (el === null || el === undefined || typeof el === 'boolean') return
  if (typeof el === 'string' || typeof el === 'number') return
  if (Array.isArray(el)) { el.forEach((c) => renderTree(c, depth)); return }
  if (typeof el.type !== 'function') return
  // class components (error boundaries): instantiate and render, no hooks
  if (el.type.prototype instanceof ReactStub.Component) {
    try {
      const inst = new el.type(Object.assign({}, el.props, { children: el.children }))
      const out = typeof inst.render === 'function' ? inst.render() : null
      renderTree(out, depth + 1)
    } catch (e) {
      failedRenders.push(`${el.type.name} (class): ${e.stack.split('\n').slice(0, 4).join('\n')}`)
    }
    return
  }
  // invoke function components recursively; audit hook count per invocation
  const owner = el.type.name || ('anon#' + depth)
  resetHooks()
  auditBegin(owner)
  if (el.type.name === 'SkillsTab') {
    // hooks: 0=items 1=msg 2=busy 3=subTab 4=edit
    hookState[0] = [[{ kind: 'skill', name: 'demo-skill', description: 'demo', enabled: true, scope: 'global', source: 'user-dsh', path: 'x', hasBody: true, readOnly: false }], () => {}]
    hookState[4] = [{ name: 'demo-skill', scope: 'global' }, () => {}] // 编辑弹窗打开
  }
  if (el.type.name === 'McpTab') {
    // hooks: 0=items 1=msg 2=busy 3=formOpen 4=probes 5=updates 6=hotReload 7=lazyActive
    hookState[4] = [{ 'mcp-demo': { reachable: true, latencyMs: 42, serverName: 'Demo' } }, () => {}]
    hookState[5] = [{ 'mcp-demo': { ok: true, status: 'unknown-installed', target: { pkg: '@scope/x', latest: '2.0.0' }, command: 'npm install -g @scope/x@2.0.0' } }, () => {}]
    hookState[6] = [true, () => {}]
  }
  let out
  try {
    out = el.type(el.props || {})
  } catch (e) {
    failedRenders.push(`${el.type.name}: ${e.stack.split('\n').slice(0, 4).join('\n')}`)
    auditEnd()
    return
  }
  // snapshot BEFORE walking children — nested components reset the counter
  auditEnd()
  renderTree(out, depth + 1)
  hookSeed = null
  if (el.children) renderTree(el.children, depth + 1)
}

const failedRenders = []
const buttonIssues = []
function collectButtons(el) {
  if (el === null || el === undefined || typeof el === 'boolean') return
  if (typeof el === 'string' || typeof el === 'number') return
  if (Array.isArray(el)) { el.forEach((c) => collectButtons(c)); return }
  if (el.type === 'button') {
    const texts = (function dig(n) {
      if (n === null || n === undefined || typeof n === 'boolean') return []
      if (typeof n === 'string' || typeof n === 'number') return [String(n)]
      if (Array.isArray(n)) return n.flatMap(dig)
      return n.children ? n.children.flatMap(dig) : []
    })(el.children)
    const label = texts.join('').trim()
    if (!label) buttonIssues.push(`empty <button>: ${JSON.stringify(el.props && el.props.className)} @${where}`)
  }
  if (el.children) collectButtons(el.children)
}
let where = ''
function renderSectionWithTab(slot, tabValue) {
  resetHooks()
  hookState[0] = [tabValue, () => {}] // active tab
  if (tabValue === 'skills') hookState[3] = [true, () => {}] // create form open
  if (tabValue === 'mcp') hookState[3] = [true, () => {}] // add form open
  let tree
  try {
    tree = slot.reg.component({ t: (k) => k })
  } catch (e) {
    failedRenders.push(`section root(${tabValue}): ${e.stack}`)
    return
  }
  where = tabValue
  renderTree(tree, 0)
  collectButtons(tree)
}
for (const slot of registeredSlots) {
  if (!slot.reg || !slot.reg.component) continue
  console.log(`── rendering section ${slot.reg.spec.id} ──`)
  // two identical passes per tab: hook counts must be stable (React #310 guard)
  for (let pass = 0; pass < 2; pass++) {
    for (const tab of ['skills', 'mcp', 'plugins']) {
      renderSectionWithTab(slot, tab)
    }
  }
}

// Hook-count variance check: same component must consume the same number of
// hooks on every invocation with the same seed. Variance = future React #310.
const varianceFailures = []
for (const [owner, counts] of hookAudit) {
  const unique = [...new Set(counts)]
  if (counts.length >= 2 && unique.length > 1) {
    varianceFailures.push(`${owner}: hook counts varied across renders [${counts.join(', ')}]`)
  }
}
if (varianceFailures.length) {
  for (const v of varianceFailures) failedRenders.push('HOOK VARIANCE: ' + v)
}

if (failedRenders.length) {
  console.log('\nRENDER FAILURES:')
  for (const f of failedRenders) console.log('---\n' + f)
  process.exit(1)
}
console.log(`\nALL RENDERS OK (${apiCalls.length} api calls made: ${[...new Set(apiCalls)].join(',')})`)
