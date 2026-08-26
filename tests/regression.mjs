// Offline regression suite for dsh-extension-manager host-side modules.
// Run from the package root:  node tests/regression.mjs
// Network-dependent checks degrade to warnings instead of failures.
import fs from 'node:fs'
import { listSkills, listMcp } from '../lib/list.mjs'
import { previewCompositionWrite, commitVerifiedWrite } from '../lib/writepipeline.mjs'
import { setServerDisabled, removeServer, toggleMap } from '../lib/region.mjs'
import { detectUpgradeTarget, probeMcpById } from '../lib/mcpcheck.mjs'

let passed = 0
let failed = 0
const warn = []
function check(name, cond) {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`)
  }
}

console.log('── syntax-adjacent imports ──')
check('modules imported', true)

console.log('── listing against real DSH home ──')
const skills = listSkills()
const mcp = listMcp()
check('listSkills returns array', Array.isArray(skills))
check('listMcp returns array', Array.isArray(mcp))
for (const s of skills.slice(0, 3)) {
  check(`skill item shape (${s.name})`, typeof s.name === 'string' && typeof s.enabled === 'boolean')
}
for (const m of mcp.slice(0, 3)) {
  check(`mcp item shape (${m.id})`, typeof m.id === 'string' && 'enabled' in m)
}

console.log('── write pipeline ──')
const tmp = './.regression.tmp.yml'
fs.writeFileSync(tmp, '# user content\n', 'utf8')
const c1 = commitVerifiedWrite(tmp, 'a: [1,2]\n')
check('clean commit ok', c1.ok === true && fs.readFileSync(tmp, 'utf8') === 'a: [1,2]\n')
const c2 = commitVerifiedWrite(tmp, 'a: [1,2\n')
check(
  'broken yaml blocked + restored',
  c2.ok === false && c2.restored === true && fs.readFileSync(tmp, 'utf8') === 'a: [1,2]\n'
)

const p1 = previewCompositionWrite({
  filePath: './x.yml',
  nextText: '- insert:\n    - id: dup-test-row\n      name: y\n',
})
check('clean preview passes', p1.ok === true)
const p2 = previewCompositionWrite({ filePath: './x.yml', nextText: 'a: [\n' })
check('invalid yaml rejected at preview', p2.ok === false)

console.log('── managed region ──')
fs.writeFileSync(
  tmp,
  '# user content\n- insert:\n    - id: mcp-demo\n      name: x\n',
  'utf8'
)
setServerDisabled(tmp, 'hmr', false)
check('toggle written', toggleMap(tmp).hmr === false)
removeServer(tmp, 'hmr')
check(
  'toggle removed, user content kept',
  Object.keys(toggleMap(tmp)).length === 0 && fs.readFileSync(tmp, 'utf8').includes('mcp-demo')
)

console.log('── upgrade-target parsing ──')
check(
  'npx scoped pkg',
  JSON.stringify(detectUpgradeTarget({ transport: 'stdio', command: 'npx', args: ['-y', '@scope/pkg@1.0.0'] })) ===
    '{"ecosystem":"npm","pkg":"@scope/pkg","version":"1.0.0"}'
)
check(
  'uvx pypi pkg',
  detectUpgradeTarget({ transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] })?.ecosystem === 'pypi'
)
check('http rows have no target', detectUpgradeTarget({ transport: 'streamable-http', url: 'http://x' }) === null)

console.log('── connectivity probe (network, degrades to warning) ──')
try {
  const r = await probeMcpById('__nonexistent__')
  check('probe of missing row reports problem', r.ok === false)
} catch (e) {
  warn.push(`probe missing-row: ${e.message}`)
}

fs.rmSync(tmp, { force: true })
console.log(`\nresult: ${passed} passed, ${failed} failed${warn.length ? `, ${warn.length} warnings` : ''}`)
warn.forEach((w) => console.log(`  warn ${w}`))
process.exit(failed === 0 ? 0 : 1)
