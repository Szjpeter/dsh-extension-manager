import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const base = resolve('.')
const files = [
  'lib/host.js', 'lib/client.js', 'lib/plugins.mjs',
  'lib/list.mjs', 'lib/mcpcheck.mjs', 'lib/writepipeline.mjs',
  'lib/install.mjs', 'lib/github.mjs', 'lib/github-bridge.mjs',
  'lib/mcpclient-lite.mjs', 'tests/regression.mjs', 'tests/render.mjs'
]
for (const f of files) {
  const content = readFileSync(resolve(base, f), 'utf8')
  console.log(f + ': ' + content.length + ' chars')
}
