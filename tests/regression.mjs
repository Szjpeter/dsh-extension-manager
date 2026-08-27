// Offline regression suite for dsh-extension-manager host-side modules.
// Run from the package root:  node tests/regression.mjs
// Network-dependent checks degrade to warnings instead of failures.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listSkills, listMcp } from '../lib/list.mjs'
import { previewCompositionWrite, commitVerifiedWrite } from '../lib/writepipeline.mjs'
import { setServerDisabled, removeServer, toggleMap } from '../lib/region.mjs'
import { detectUpgradeTarget, probeMcpById } from '../lib/mcpcheck.mjs'
import { parseYaml } from '../lib/yaml.mjs'
import { findMcpEntryAnywhere, toggleMcp, removeMcp } from '../lib/mcp.mjs'
import { upsertServer } from '../lib/region.mjs'

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

console.log('── yaml subset ──')
{
  // Regression lock for the block-scalar fix: comment-LOOKING lines inside a
  // literal block are content. The old indent-detection skipped them, which
  // silently dropped leading "# ..." description lines on read (and a later
  // UI save persisted the loss).
  const doc = parseYaml('description: |\n  # Title line\n  second line\nname: t\n')
  check('literal block keeps leading # line', doc && doc.description === '# Title line\nsecond line\n')
}

console.log('── preview guards ──')
{
  const dup =
    '- insert:\n    - id: dup-id-1\n      name: a\n- insert:\n    - id: dup-id-1\n      name: b\n'
  const pdup = previewCompositionWrite({ filePath: './x.yml', nextText: dup })
  check('same-document duplicate insert id rejected', pdup.ok === false)

  // Own-generation supersede must pass; a DIFFERENT layer carrying the same
  // insert id must still be refused.
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'exm-preview-'))
  try {
    const profDir = path.join(iso, 'profiles', 'web')
    fs.mkdirSync(profDir, { recursive: true })
    const patchFile = path.join(profDir, 'cordis.patch.yml')
    const layerText = '- insert:\n    - id: own-row-9\n      name: pkg-a\n'
    fs.writeFileSync(patchFile, layerText, 'utf8')

    const supersede = previewCompositionWrite({
      filePath: patchFile,
      nextText: layerText,
      profileDir: profDir,
      dshHome: iso,
    })
    check('rewriting the SAME file may repeat its own rows', supersede.ok === true)

    fs.mkdirSync(path.join(profDir, 'node_modules', 'pkg-b'), { recursive: true })
    fs.writeFileSync(
      path.join(profDir, 'node_modules', 'pkg-b', 'package.json'),
      JSON.stringify({ name: 'pkg-b', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
      'utf8'
    )
    fs.writeFileSync(path.join(profDir, 'node_modules', 'pkg-b', 'cordis.patch.yml'), layerText, 'utf8')
    const collide = previewCompositionWrite({
      filePath: './other.yml',
      nextText: '- insert:\n    - id: other-x\n      name: y\n',
      profileDir: profDir,
      dshHome: iso,
    })
    // No collision for a fresh id...
    check('fresh id passes cross-layer scan', collide.ok === true)
    const collide2 = previewCompositionWrite({
      filePath: './other.yml',
      nextText: '- insert:\n    - id: own-row-9\n      name: z\n',
      profileDir: profDir,
      dshHome: iso,
    })
    check('id already inserted in ANOTHER layer is refused', collide2.ok === false &&
      String(collide2.problems).includes('own-row-9'))
  } finally {
    fs.rmSync(iso, { recursive: true, force: true })
  }
}

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
check(
  'npx.cmd absolute path detected (G3)',
  JSON.stringify(detectUpgradeTarget({ transport: 'stdio', command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', '@scope/pkg@2'] })) ===
    '{"ecosystem":"npm","pkg":"@scope/pkg","version":"2"}'
)
check(
  'uvx.exe basename detected (G3)',
  detectUpgradeTarget({ transport: 'stdio', command: '%LOCALAPPDATA%\\uv\\uvx.exe', args: ['mcp-server-fetch'] })?.ecosystem === 'pypi'
)

console.log('── connectivity probe (network, degrades to warning) ──')
try {
  const r = await probeMcpById('__nonexistent__')
  check('probe of missing row reports problem', r.ok === false)
} catch (e) {
  warn.push(`probe missing-row: ${e.message}`)
}

console.log('── layer routing (M5) ──')
{
  // Toggle/remove/probe must dispatch on the row's OWN layer. This section
  // runs inside an isolated DSH_HOME (restored in finally) seeded with a
  // preset-layer row only — the old code answered "未找到"/no-op'd for it.
  const prevHome = process.env.DSH_HOME
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'exm-scope-'))
  try {
    process.env.DSH_HOME = iso
    fs.mkdirSync(path.join(iso, 'profiles', 'web'), { recursive: true })
    const presetDir = path.join(iso, '.agent-presets', 'demo-mcp')
    fs.mkdirSync(presetDir, { recursive: true })
    const presetFile = path.join(presetDir, 'agent.cordis.yml')
    fs.writeFileSync(presetFile, '# demo notes\n')

    upsertServer(presetFile, {
      id: 'mcp-presety',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'Presety', transport: 'streamable-http', url: 'http://127.0.0.1:9/unreachable' },
    })

    const found = findMcpEntryAnywhere('Presety') || findMcpEntryAnywhere('mcp-presety')
    check('cross-layer lookup resolves a preset row',
      !!found && found.locationKind === 'preset' && found.location === presetFile)
    check('cross-layer lookup carries the row config',
      !!found && !!found.config && found.config.url === 'http://127.0.0.1:9/unreachable')

    toggleMcp('mcp-presety', true)
    let parsed = parseYaml(fs.readFileSync(presetFile, 'utf8')) || []
    let toggleRow = parsed.find((e) => e && e.id === 'mcp-presety')
    check('toggle writes into the OWNING preset layer',
      !!toggleRow && toggleRow.disabled === true)

    const flip = toggleMcp('Presety')
    parsed = parseYaml(fs.readFileSync(presetFile, 'utf8')) || []
    toggleRow = parsed.find((e) => e && e.id === 'mcp-presety')
    check('boolean-less toggle flips current layer state',
      flip.disabled === false && !!toggleRow && toggleRow.disabled === false)

    const rem = removeMcp('mcp-presety')
    parsed = parseYaml(fs.readFileSync(presetFile, 'utf8')) || []
    const stillThere = parsed.some(
      (e) => e && ((e.insert && e.insert[0] && e.insert[0].id === 'mcp-presety') || e.id === 'mcp-presety')
    )
    check('remove deletes from the owning preset layer',
      rem.removed === true && !stillThere && fs.readFileSync(presetFile, 'utf8').includes('# demo notes'))

    const absentAgain = removeMcp('mcp-presety')
    check('removing an already-gone id reports a no-op',
      !!absentAgain && absentAgain.noop === true)

    // Absent-id removal on the GLOBAL patch remains byte-neutral.
    const webPatch = path.join(iso, 'profiles', 'web', 'cordis.patch.yml')
    upsertServer(webPatch, { id: 'mcp-real', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'Real', transport: 'stdio', command: 'node' } })
    const beforeBytes = fs.readFileSync(webPatch, 'utf8')
    removeMcp('mcp-not-there-anywhere')
    check('global-patch absent-id removal is byte-neutral',
      fs.readFileSync(webPatch, 'utf8') === beforeBytes)
  } finally {
    process.env.DSH_HOME = prevHome
    fs.rmSync(iso, { recursive: true, force: true })
  }
}

fs.rmSync(tmp, { force: true })
// Test hygiene: the write pipeline rotates backup generations next to every
// target it commits — sweep our own ring so runs never litter the repo.
// (Target basename is the dotfile ".regression.tmp.yml", so ring files start
// with TWO dots: "..regression.tmp.yml.bak.N" — match by infix.)
for (const f of fs.readdirSync('.')) {
  if (f.includes('regression.tmp.yml.bak.')) fs.rmSync(f, { force: true })
}
console.log(`\nresult: ${passed} passed, ${failed} failed${warn.length ? `, ${warn.length} warnings` : ''}`)
warn.forEach((w) => console.log(`  warn ${w}`))
process.exit(failed === 0 ? 0 : 1)
