// OFFLINE unit test for the Release-channel pure helpers in plugins.mjs.
// No network: exercises provenance roundtrip, version compare, asset naming,
// and peer-dep linking against a fake runtime node_modules.
//
//   node tests/release-channel-offline.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const testHome = path.join(process.cwd(), '.tmp-rel-offline')
fs.rmSync(testHome, { recursive: true, force: true })
fs.mkdirSync(path.join(testHome, 'profiles', 'web'), { recursive: true })
fs.mkdirSync(path.join(testHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh-mcp-client'), { recursive: true })
fs.writeFileSync(path.join(testHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'package.json'), '{"name":"@deepseek-ai/dsh-mcp-client"}', 'utf8')
process.env.DSH_HOME = path.join(testHome, 'dsh')

const { writePluginOrigin, linkPeerDeps, compareVersions } = await import('../lib/plugins.mjs')

let failures = 0
function check(label, cond, extra = '') {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.log(`  ✗ ${label} ${extra}`) }
}

console.log('A. compareVersions')
check('1.0.0 < 1.0.1', compareVersions('1.0.0', '1.0.1') < 0)
check('0.2.9 > 0.2.8', compareVersions('0.2.9', '0.2.8') > 0)
check('equal', compareVersions('0.2.9', '0.2.9') === 0)

console.log('B. provenance roundtrip with mirrors')
{
  const dir = path.join(testHome, 'probe')
  fs.mkdirSync(dir, { recursive: true })
  const release = {
    assetPattern: 'tonghuasun-agent-deepseek-harness-<version>.tgz',
    versionFile: 'update/stable.json',
    mirrors: ['qicuo/tonghuasun-agent'],
  }
  check('write ok', writePluginOrigin(dir, 'zhuyifang/tonghuasun-agent', release))
  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.dsh-plugin-origin.json'), 'utf8'))
  check('assetPattern persisted', raw.release.assetPattern === release.assetPattern)
  check('mirrors persisted', Array.isArray(raw.release.mirrors) && raw.release.mirrors[0] === 'qicuo/tonghuasun-agent')
}

console.log('C. linkPeerDeps — junction located via LOCALAPPDATA runtime (real dsh web scenario: system node, not runtime node.exe)')
{
  const pluginDir = path.join(testHome, 'plugin-install')
  fs.mkdirSync(pluginDir, { recursive: true })
  // Simulate dsh web running under the SYSTEM node: execPath stays the real
  // node binary; the harness modules are found via LOCALAPPDATA.
  const origLocalAppData = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = path.join(testHome, 'localappdata')
  const runtimeNm = path.join(testHome, 'localappdata', 'DeepSeek Harness', 'runtime', 'node_modules')
  fs.mkdirSync(path.join(runtimeNm, '@deepseek-ai', 'dsh-mcp-client'), { recursive: true })
  fs.writeFileSync(path.join(runtimeNm, '@deepseek-ai', 'dsh-mcp-client', 'package.json'), '{}', 'utf8')
  try {
    const r = linkPeerDeps(pluginDir, { peerDependencies: { '@deepseek-ai/dsh-mcp-client': '^0.1.0' } })
    check('link ok', r.ok === true, JSON.stringify(r))
    check('source resolved via LOCALAPPDATA', r.source === runtimeNm, JSON.stringify(r.source))
    const linkPath = path.join(pluginDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client')
    check('link target exists', fs.existsSync(linkPath))
    check('link resolves the fake package', fs.existsSync(path.join(linkPath, 'package.json')))
  } finally {
    process.env.LOCALAPPDATA = origLocalAppData
  }
}

console.log('C2. linkPeerDeps — explicit sourceHint wins over LOCALAPPDATA')
{
  const pluginDir = path.join(testHome, 'plugin-install-1b')
  fs.mkdirSync(pluginDir, { recursive: true })
  const hintDir = path.join(testHome, 'hint-nm')
  fs.mkdirSync(path.join(hintDir, '@deepseek-ai', 'dsh-mcp-client'), { recursive: true })
  fs.writeFileSync(path.join(hintDir, '@deepseek-ai', 'dsh-mcp-client', 'package.json'), '{}', 'utf8')
  const r = linkPeerDeps(pluginDir, { peerDependencies: { '@deepseek-ai/dsh-mcp-client': '^0.1.0' } }, hintDir)
  check('hint used', r.ok === true && r.source === hintDir, JSON.stringify(r))
}

console.log('D. linkPeerDeps — missing peer source is reported as skipped, not fatal')
{
  const pluginDir = path.join(testHome, 'plugin-install-2')
  fs.mkdirSync(pluginDir, { recursive: true })
  const r = linkPeerDeps(pluginDir, { peerDependencies: { '@deepseek-ai/does-not-exist': '^1.0.0' } })
  check('skipped reported (missing peer is a signal, not fatal)', r.skipped.length === 1, JSON.stringify(r))
}

console.log('E. no-peer package links nothing')
{
  const pluginDir = path.join(testHome, 'plugin-install-3')
  fs.mkdirSync(pluginDir, { recursive: true })
  const r = linkPeerDeps(pluginDir, {})
  check('empty result', r.ok === true && r.linked.length === 0 && r.skipped.length === 0, JSON.stringify(r))
}

if (failures === 0) { fs.rmSync(testHome, { recursive: true, force: true }); console.log('\nALL OFFLINE TESTS PASSED') }
else { console.log(`\n${failures} failure(s); temp home kept at ${testHome}`) }
process.exit(failures === 0 ? 0 : 1)
