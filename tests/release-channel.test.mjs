// Release-channel (GitHub Release tgz) end-to-end test for the extension
// manager. Runs against the REAL zhuyifang/tonghuasun-agent repo (network),
// but writes everything under a temp DSH_HOME inside the workspace so no
// production file is touched. Version-agnostic: the expected version is read
// from the repo's update/stable.json at test start.
//
//   node tests/release-channel.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'zhuyifang/tonghuasun-agent'
const ASSET = { assetPattern: 'tonghuasun-agent-deepseek-harness-<version>.tgz', versionFile: 'update/stable.json' }

// Isolated DSH home: workspace/.tmp-rel-test/dsh
const testHome = path.join(process.cwd(), '.tmp-rel-test', 'dsh')
fs.rmSync(testHome, { recursive: true, force: true })
fs.mkdirSync(path.join(testHome, 'profiles', 'web'), { recursive: true })
const webProfileDir = path.join(testHome, 'profiles', 'web')
fs.writeFileSync(
  path.join(webProfileDir, 'package.json'),
  JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  'utf8'
)
fs.writeFileSync(path.join(webProfileDir, 'cordis.patch.yml'), '', 'utf8')
process.env.DSH_HOME = testHome

const { writePluginOrigin, chooseInstallChannel, installReleasePlugin, updatePluginItem, checkPluginUpdates } =
  await import('../lib/plugins.mjs')

let failures = 0
function check(label, cond, extra = '') {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.log(`  ✗ ${label} ${extra}`) }
}

// Expected version from the author's version file (remote, mirror-aware).
const info = await (async () => {
  const urls = [
    `https://raw.githubusercontent.com/${REPO}/HEAD/update/stable.json`,
    `https://gitee.com/qicuo/tonghuasun-agent/raw/main/update/stable.json`, // learned mirror (owner differs!)
    `https://gitee.com/qicuo/tonghuasun-agent/raw/master/update/stable.json`,
  ]
  for (const u of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(15000) })
        if (res.ok) return (await res.json()).latestVersion
      } catch {
        await new Promise((r) => setTimeout(r, 800))
      }
    }
  }
  throw new Error('cannot reach version file on any mirror')
})()
console.log(`remote latestVersion = ${info}`)

console.log('A. provenance roundtrip (release flavor)')
{
  const dir = path.join(testHome, 'probe-origin')
  fs.mkdirSync(dir, { recursive: true })
  check('writePluginOrigin ok', writePluginOrigin(dir, REPO, ASSET) === true)
  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.dsh-plugin-origin.json'), 'utf8'))
  check('repo recorded', raw.repo === REPO)
  check('release.assetPattern recorded', raw.release.assetPattern === ASSET.assetPattern)
  check('release.versionFile defaulted', raw.release.versionFile === 'update/stable.json')
  check('plain form still works', writePluginOrigin(dir, 'owner/plain') === true)
}

console.log('B. chooseInstallChannel picks the release channel')
{
  const choice = await chooseInstallChannel(REPO, 'deepseek-harness')
  check(`channel=release (got ${choice.channel})`, choice.channel === 'release', JSON.stringify(choice))
  if (choice.channel === 'release') check('assetPattern derived', choice.release.assetPattern === ASSET.assetPattern)
}

console.log('C. installReleasePlugin (real download)')
let installOk = false
{
  const r = await installReleasePlugin(webProfileDir, REPO, ASSET)
  check('install ok', r.ok === true, JSON.stringify(r).slice(0, 300))
  installOk = r.ok === true
  const pluginDir = path.join(testHome, 'extension-manager', 'plugins', 'tonghuasun-agent')
  check('plugin dir exists', fs.existsSync(pluginDir))
  if (fs.existsSync(pluginDir)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
    check(`version ${info} (got ${pkg.version})`, pkg.version === info)
    check('proxy script present', fs.existsSync(path.join(pluginDir, 'scripts', 'tonghuasun-mcp-proxy.mjs')))
    check('provenance written', fs.existsSync(path.join(pluginDir, '.dsh-plugin-origin.json')))
    const patch = fs.readFileSync(path.join(webProfileDir, 'cordis.patch.yml'), 'utf8')
    check('row registered in profile patch', /id:\s*tonghuasun-agent/.test(patch))
  }
}

if (!installOk) {
  console.log('\nC failed — skipping D/E/F (temp home kept for inspection)')
  process.exit(failures === 0 ? 0 : 1)
}

const pluginDir = path.join(testHome, 'extension-manager', 'plugins', 'tonghuasun-agent')
const pkgPath = path.join(pluginDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const entryUrl = pathToFileURL(path.join(pluginDir, pkg.main)).href

console.log('D. updatePluginItem — already latest')
{
  const r = await updatePluginItem(webProfileDir, entryUrl)
  check('returns already-latest message', r.ok === true && /已是最新/.test(r.message), JSON.stringify(r))
}

console.log('E. updatePluginItem — real swap path (fake 0.0.1 → latest)')
{
  pkg.version = '0.0.1'
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8')
  const r = await updatePluginItem(webProfileDir, entryUrl)
  check('swap ok', r.ok === true && /已更新/.test(r.message), JSON.stringify(r).slice(0, 300))
  const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  check(`version back to ${info} (got ${after.version})`, after.version === info)
  check('provenance survives swap', fs.existsSync(path.join(pluginDir, '.dsh-plugin-origin.json')))
  check('no .bak leftover', !fs.existsSync(pluginDir + '.bak'))
}

console.log('F. checkPluginUpdates routes the plugin as kind=release')
{
  const fakeLoader = {
    entries: () => [{ id: 'tonghuasun-agent', options: { name: entryUrl, group: undefined }, disabled: false, fiber: { state: 0 } }],
  }
  const ctx = { get: (k) => (k === 'loader' ? fakeLoader : undefined) }
  const { plugins } = await checkPluginUpdates(ctx, webProfileDir)
  const hit = (plugins || []).find((p) => p.name === pluginDir)
  check('plugin found in scan', !!hit)
  if (hit) {
    check(`kind=release (got ${hit.kind})`, hit.kind === 'release')
    check(`current=${info}`, hit.current === info)
    check(`latest=${info}`, hit.latest === info)
    check('updateable=false (already latest)', hit.updateable === false)
  }
}

// Cleanup the temp home (keep on failure for inspection)
if (failures === 0) fs.rmSync(testHome, { recursive: true, force: true })
else console.log(`\n${failures} failure(s); temp home kept at ${testHome}`)
process.exit(failures === 0 ? 0 : 1)
