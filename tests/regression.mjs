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
import { parseYaml, splitFrontmatter } from '../lib/yaml.mjs'
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

console.log('── BOM immunity (2026-08-27 mine, struck twice) ──')
{
  // PowerShell-edited files carry EF BB BF. It blanked the shared `list` RPC
  // twice (patch layers on 08-27, then mcp-servers.yaml). Parser-level strip
  // plus array guards must make ANY poisoned file listable, not fatal.
  const prevHome = process.env.DSH_HOME
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'exm-bom-'))
  try {
    process.env.DSH_HOME = iso
    fs.mkdirSync(path.join(iso, '.git'), { recursive: true }) // projectRoot anchor
    fs.mkdirSync(path.join(iso, '.dsh'), { recursive: true })
    const manifestFile = path.join(iso, '.dsh', 'mcp-servers.yaml')
    // EXACT bytes a PowerShell-edited manifest carries: BOM + block sequence.
    fs.writeFileSync(
      manifestFile,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('- id: mcp-bomy\n  name: \'@deepseek-ai/dsh-mcp-client\'\n  config:\n    serverName: Bomy\n    transport: stdio\n    command: node\n'),
      ])
    )
    const rows = listMcp(iso)
    const hit = rows.find((r) => r.source === 'manifest' && r.id === 'mcp-bomy')
    check('BOM-poisoned manifest lists its rows (no "not iterable")',
      rows.length >= 1 && !!hit && hit.serverName === 'Bomy')

    // The raw-text frontmatter paths must be immune as well.
    const md = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('---\nname: bom-skill\ndescription: ok\n---\nbody\n'),
    ])
    const fm = splitFrontmatter(md.toString('utf8'))
    check('BOM-poisoned SKILL.md frontmatter still recognized',
      !!fm.frontmatter && fm.frontmatter.name === 'bom-skill' && fm.body === 'body\n')
  } finally {
    process.env.DSH_HOME = prevHome
    fs.rmSync(iso, { recursive: true, force: true })
  }
}

console.log('── git repo classifier ──')
{
  // SodaMem regression: a repo whose package.json HAS dsh.bundle.patch was
  // shown as 非 DSH 插件 when the MCP-bridge read hiccupped and the failure
  // was silently classified "unknown". Now: retry, read-error is distinct,
  // and cordis artifacts are a second identity signal.
  const gh = await import('../lib/github.mjs')
  function browseFixture(filesMap) {
    return gh.detectRepoUnitsWithLister(
      async (dir) => {
        const prefix = dir ? dir + '/' : ''
        return Object.keys(filesMap)
          .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
          .map((p) => ({ name: p.slice(prefix.length), path: p, type: 'file' }))
      },
      async (p) => {
        const v = filesMap[p]
        if (v === undefined) throw new Error('404 ' + p)
        if (v instanceof Error) throw v
        return v
      }
    )
  }
  const a = await browseFixture({
    'package.json': JSON.stringify({ name: 'x', main: 'i.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  })
  check('dsh field → dsh-plugin', a.plugins[0]?.kind === 'dsh-plugin' && a.plugins[0].name === 'x')
  const b = await browseFixture({
    'package.json': JSON.stringify({ name: 'y', main: 'i.js' }),
    'cordis.patch.yml': 'stub\n',
  })
  check('cordis artifact → dsh-plugin even without dsh field', b.plugins[0]?.kind === 'dsh-plugin')
  const c = await browseFixture({
    'package.json': JSON.stringify({ name: 'mcp-thing', bin: { x: 'b' } }),
  })
  check('bin pkg → mcp-server', c.plugins[0]?.kind === 'mcp-server')
  const d = await browseFixture({
    'package.json': new Error('network reset'),
  })
  check('unreadable package.json → read-error (NOT unknown)', d.plugins[0]?.kind === 'read-error')
  const e = await browseFixture({
    'package.json': JSON.stringify({ name: 'plain-pkg' }),
  })
  check('plain npm pkg → unknown', e.plugins[0]?.kind === 'unknown')
}

console.log('── git clone install: stale-dir recovery ──')
{
  // A failed network clone used to leave a half-created dir, and the
  // "目录已存在，可能已安装" guard wedged every retry forever while the
  // Plugins tab (correctly) showed nothing. Now an existing dir is validated:
  // good → register without re-cloning; bad → wiped and reinstalled fresh.
  const prevHome = process.env.DSH_HOME
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'exm-clone-'))
  try {
    process.env.DSH_HOME = iso
    const profDir = path.join(iso, 'profiles', 'web')
    fs.mkdirSync(profDir, { recursive: true })
    const { installPlugin, validateClonePackage } = await import('../lib/plugins.mjs')

    // validator branches (no network)
    fs.mkdirSync(path.join(iso, 'v-ok'), { recursive: true })
    fs.writeFileSync(path.join(iso, 'v-ok', 'package.json'), JSON.stringify({ name: 'x', main: 'index.js' }))
    fs.writeFileSync(path.join(iso, 'v-ok', 'index.js'), 'export {}\n')
    check('validator: valid clone passes', validateClonePackage(path.join(iso, 'v-ok')).ok === true)
    fs.mkdirSync(path.join(iso, 'v-nomain'), { recursive: true })
    fs.writeFileSync(path.join(iso, 'v-nomain', 'package.json'), JSON.stringify({ name: 'y' }))
    check('validator: missing main refused', validateClonePackage(path.join(iso, 'v-nomain')).ok === false)
    fs.mkdirSync(path.join(iso, 'v-deps'), { recursive: true })
    fs.writeFileSync(path.join(iso, 'v-deps', 'package.json'), JSON.stringify({ name: 'z', main: 'i.js', dependencies: { lodash: '^4' } }))
    check('validator: runtime deps refused', validateClonePackage(path.join(iso, 'v-deps')).ok === false)

    // stale-but-valid dir → registered WITHOUT any network clone
    const staleDir = path.join(iso, 'extension-manager', 'plugins', 'stale-plug')
    fs.mkdirSync(staleDir, { recursive: true })
    fs.writeFileSync(path.join(staleDir, 'package.json'), JSON.stringify({ name: 'stale-plug', main: 'index.js' }))
    fs.writeFileSync(path.join(staleDir, 'index.js'), 'export {}\n')
    const r = await installPlugin(profDir, 'someuser/stale-plug')
    const patchText = fs.readFileSync(path.join(profDir, 'cordis.patch.yml'), 'utf8')
    check('stale valid dir is registered, not wedged',
      r.ok === true && String(r.message).includes('已补写注册行') && /- id: stale-plug/.test(patchText))

    // sodamem-class guard: a clone whose bundle layer carries REQUIRED config
    // (apiUrl) must get that config merged into the registered row — a
    // config-less row failed loader activation and broke `dsh web` boot.
    const cfgDir = path.join(iso, 'extension-manager', 'plugins', 'cfg-plug')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'package.json'), JSON.stringify({ name: 'cfg-plug', main: 'index.js' }))
    fs.writeFileSync(path.join(cfgDir, 'index.js'), 'export {}\n')
    fs.writeFileSync(path.join(cfgDir, 'cordis.patch.yml'),
      '- insert:\n    - id: cfg-plug\n      name: cfg-plug\n      config:\n        apiUrl: \'http://127.0.0.1:8000\'\n        tokenBudget: 1200\n')
    const rc = await installPlugin(profDir, 'someuser/cfg-plug')
    const cfgText = fs.readFileSync(path.join(profDir, 'cordis.patch.yml'), 'utf8')
    const cfgDoc = parseYaml(cfgText) || []
    let cfgRow = null
    for (const e of cfgDoc) {
      if (e && Array.isArray(e.insert)) {
        for (const inner of e.insert) {
          if (inner && inner.id === 'cfg-plug') cfgRow = inner
        }
      }
    }
    check('bundle-layer config merged into registered row (sodamem-class)',
      rc.ok === true && !!cfgRow && cfgRow.config && cfgRow.config.apiUrl === 'http://127.0.0.1:8000' &&
      String(rc.message).includes('已合并插件自带的默认配置'))

    // `!!js` configs cannot be re-emitted faithfully — merge must be SKIPPED
    // (row registered config-less, exactly the old behavior) instead of
    // corrupting the patch with a {__js} map.
    const jsDir = path.join(iso, 'extension-manager', 'plugins', 'js-plug')
    fs.mkdirSync(jsDir, { recursive: true })
    fs.writeFileSync(path.join(jsDir, 'package.json'), JSON.stringify({ name: 'js-plug', main: 'index.js' }))
    fs.writeFileSync(path.join(jsDir, 'index.js'), 'export {}\n')
    fs.writeFileSync(path.join(jsDir, 'cordis.patch.yml'),
      '- insert:\n    - id: js-plug\n      name: js-plug\n      config:\n        token: !!js process.env.TOKEN\n')
    const rj = await installPlugin(profDir, 'someuser/js-plug')
    const jsText = fs.readFileSync(path.join(profDir, 'cordis.patch.yml'), 'utf8')
    const jsDoc = parseYaml(jsText) || []
    let jsRow = null
    for (const e of jsDoc) {
      if (e && Array.isArray(e.insert)) {
        for (const inner of e.insert) {
          if (inner && inner.id === 'js-plug') jsRow = inner
        }
      }
    }
    check('non-serializable (!!js) config merge skipped safely',
      rj.ok === true && !!jsRow && (!jsRow.config || jsRow.config.token === undefined) &&
      !String(rj.message).includes('已合并'))
  } finally {
    process.env.DSH_HOME = prevHome
    fs.rmSync(iso, { recursive: true, force: true })
  }
}

console.log('── zip plugin update check + auto update (origin provenance) ──')
{
  const prevHome = process.env.DSH_HOME
  const realFetch = globalThis.fetch
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'exm-zipupd-'))
  try {
    process.env.DSH_HOME = iso
    const profDir = path.join(iso, 'profiles', 'web')
    fs.mkdirSync(profDir, { recursive: true })
    const { writePluginOrigin, compareVersions, checkPluginUpdates, updatePluginItem } = await import('../lib/plugins.mjs')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)

    check('compareVersions: newer/older/equal',
      compareVersions('2.0.0', '1.9.9') === 1 &&
      compareVersions('1.0.0', '1.0.0') === 0 &&
      compareVersions('1.0.0', '2.0.0') === -1 &&
      compareVersions('0.2.10', '0.2.9') === 1)

    const plugDir = path.join(iso, 'extension-manager', 'plugins', 'zip-plug')
    fs.mkdirSync(plugDir, { recursive: true })
    fs.writeFileSync(path.join(plugDir, 'package.json'), JSON.stringify({ name: 'zip-plug', version: '1.0.0', main: 'index.js' }))
    fs.writeFileSync(path.join(plugDir, 'index.js'), 'export {}\n')
    check('writePluginOrigin accepts owner/repo', writePluginOrigin(plugDir, 'someuser/zip-plug') === true)
    check('writePluginOrigin rejects non-repo strings', writePluginOrigin(plugDir, 'not-a-repo') === false)

    // Mock network by URL: search endpoint (query-aware), raw package.json,
    // and tarball payloads. Build a REAL tar.gz (via system tar) WITH a
    // top-level directory — exactly how GitHub tarballs are laid out — so
    // zipUpdate's extraction path is exercised end-to-end.
    const remoteSrc = path.join(iso, 'remote-src', 'zip-plug-HEAD')
    fs.mkdirSync(remoteSrc, { recursive: true })
    fs.writeFileSync(path.join(remoteSrc, 'package.json'), JSON.stringify({ name: 'zip-plug', version: '2.0.0', main: 'index.js' }))
    fs.writeFileSync(path.join(remoteSrc, 'index.js'), 'export const v2 = true\n')
    const ball = path.join(iso, 'zip-plug.tgz')
    await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', ball, '-C', path.join(iso, 'remote-src'), 'zip-plug-HEAD'])

    globalThis.fetch = async (url = '') => {
      const u = String(url)
      if (u.includes('/search/repositories')) {
        const m = u.match(/q=([^&]+)/)
        const q = m ? decodeURIComponent(m[1]).split('+')[0] : 'none'
        return { ok: true, status: 200, json: async () => ({ items: [{ full_name: 'someuser/' + q, name: q }] }) }
      }
      if (u.includes('/tarball/')) {
        const b = fs.readFileSync(ball)
        return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
      }
      const wantsPlain = u.includes('zip-plain')
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ version: '2.0.0', name: wantsPlain ? 'zip-plain' : 'zip-plug' }),
        json: async () => ({ version: '2.0.0', name: wantsPlain ? 'zip-plain' : 'zip-plug' }),
      }
    }
    const mkCtx = (dirs) => ({
      get: () => ({
        entries: () => dirs.map((d) => ({
          id: 'include:' + path.basename(d),
          options: { name: 'file:///' + d.replace(/\\/g, '/') + '/index.js' },
        })),
      }),
    })
    const ctx = mkCtx([plugDir])
    const r = await checkPluginUpdates(ctx, profDir)
    const row = r.plugins.find((p) => p.name && p.name.includes('zip-plug'))
    check('zip plugin version-compares via origin file',
      !!row && row.kind === 'zip' && row.updateable === true && row.current === '1.0.0' && row.latest === '2.0.0')

    // One-click zip update: download tarball -> validate -> swap with backup.
    const upd = await updatePluginItem(profDir, 'file:///' + plugDir.replace(/\\/g, '/') + '/index.js')
    const newPkg = JSON.parse(fs.readFileSync(path.join(plugDir, 'package.json'), 'utf8'))
    check('zip auto-update swaps to remote version',
      upd.ok === true && newPkg.version === '2.0.0' && fs.existsSync(path.join(plugDir, 'index.js')))
    check('zip update preserves provenance', JSON.parse(fs.readFileSync(path.join(plugDir, '.dsh-plugin-origin.json'), 'utf8')).repo === 'someuser/zip-plug')

    // Origin-less dir: source AUTO-RESOLVED by name search + two-signal
    // confirm, then persisted — the next check no longer needs the search.
    const plainDir = path.join(iso, 'extension-manager', 'plugins', 'zip-plain')
    fs.mkdirSync(plainDir, { recursive: true })
    fs.writeFileSync(path.join(plainDir, 'package.json'), JSON.stringify({ name: 'zip-plain', version: '1.0.0', main: 'index.js' }))
    const r2 = await checkPluginUpdates(mkCtx([plainDir]), profDir)
    const row2 = r2.plugins.find((p) => p.name && p.name.includes('zip-plain'))
    check('origin-less zip plugin auto-resolves its source and updates',
      !!row2 && row2.kind === 'zip' && row2.updateable === true && row2.repo === 'someuser/zip-plain')
    check('auto-confirmed source is persisted',
      JSON.parse(fs.readFileSync(path.join(plainDir, '.dsh-plugin-origin.json'), 'utf8')).repo === 'someuser/zip-plain')

    // Refusal guard: a needs-building source (no main entry) must be refused
    // WITHOUT touching the installed dir. Tarball staged WITH a top-level
    // directory (GitHub layout) so it reaches the validation step.
    const remoteBad = path.join(iso, 'remote-bad', 'zip-plug-HEAD')
    fs.mkdirSync(remoteBad, { recursive: true })
    fs.writeFileSync(path.join(remoteBad, 'package.json'), JSON.stringify({ name: 'zip-plug', version: '3.0.0' }))
    await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', path.join(iso, 'bad.tgz'), '-C', path.join(iso, 'remote-bad'), 'zip-plug-HEAD'])
    const realFetch2 = globalThis.fetch
    globalThis.fetch = async (url = '') => {
      if (String(url).includes('/tarball/')) {
        const b = fs.readFileSync(path.join(iso, 'bad.tgz'))
        return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
      }
      return realFetch2(url)
    }
    try {
      const bad = await updatePluginItem(profDir, 'file:///' + plugDir.replace(/\\/g, '/') + '/index.js')
      const cur = JSON.parse(fs.readFileSync(path.join(plugDir, 'package.json'), 'utf8'))
      check('needs-building source refused, current install untouched',
        bad.ok === false && bad.code === 'invalid' && cur.version === '2.0.0' && fs.existsSync(path.join(plugDir, 'index.js')))
    } finally {
      globalThis.fetch = realFetch2
    }
  } finally {
    globalThis.fetch = realFetch
    process.env.DSH_HOME = prevHome
    fs.rmSync(iso, { recursive: true, force: true })
  }
}

console.log('── install channel decision (one button) ──')
{
  const prevFetch = globalThis.fetch
  const { chooseInstallChannel } = await import('../lib/plugins.mjs')
  globalThis.fetch = async (url = '') => {
    const u = String(url)
    if (u.startsWith('https://registry.npmjs.org/')) {
      const pkg = u.replace('https://registry.npmjs.org/', '').replace('/latest', '')
      if (pkg === 'published-plug') return { ok: true, status: 200, json: async () => ({ version: '1.0.0' }) }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    if (u.startsWith('https://raw.githubusercontent.com/')) {
      const parts = u.split('/')
      const repo = parts[3] + '/' + parts[4]
      const filePath = parts.slice(6).join('/')
      if (repo === 'ok/cloneable') {
        if (filePath === 'package.json') return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'cloneable', main: 'index.js' }) }
        if (filePath === 'index.js') return { ok: true, status: 200, text: async () => 'export {}\n' }
        return { ok: false, status: 404, text: async () => '404' }
      }
      if (repo === 'bad/ts-no-dist') {
        // package.json committed, but dist/ is NOT (the sodamem shape).
        if (filePath === 'package.json') return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'ts', main: './dist/cjs/index.js' }) }
        return { ok: false, status: 404, text: async () => '404' }
      }
      return { ok: false, status: 404, text: async () => '404' }
    }
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
  }
  try {
    check('npm published → npm channel',
      (await chooseInstallChannel('someuser/published-plug')).channel === 'npm')
    check('not on npm + valid source → clone channel',
      (await chooseInstallChannel('ok/cloneable')).channel === 'clone')
    const none1 = await chooseInstallChannel('bad/ts-no-dist')
    check('no npm + needs building → 无法安装 (main 缺失)',
      none1.channel === 'none' && String(none1.reason).includes('main 入口缺失'))
    const none2 = await chooseInstallChannel('bad/missing-repo')
    check('repo unreadable → 无法安装', none2.channel === 'none' && String(none2.reason).includes('无法读取仓库'))
  } finally {
    globalThis.fetch = prevFetch
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
