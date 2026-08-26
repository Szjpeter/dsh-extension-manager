// Live end-to-end verification against the running harness.
const BASE = 'http://127.0.0.1:3080'
async function rpc(method, args = {}) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'v', method, payload: { args: { input: args } } }),
  })
  const json = await res.json()
  return json.result ?? json
}
const ping = await rpc('extensionManager/ping')
console.log('ping:', JSON.stringify(ping))
if (ping.ok) {
  const list = await rpc('extensionManager/list')
  if (list.ok) {
    console.log(`list: skills=${list.value.skills.length} mcp=${list.value.mcp.length}`)
    for (const m of list.value.mcp) console.log(`   - ${m.serverName} (${m.transport}, enabled=${m.enabled})`)
  } else console.log('list error:', JSON.stringify(list.error))
  const status = await rpc('extensionManager/mcpStatus')
  console.log('mcpStatus:', JSON.stringify(status.ok ? status.value : status.error))
  const hr = await rpc('extensionManager/getHotReload')
  console.log('hotReload:', JSON.stringify(hr.ok ? hr.value : hr.error))
  const plugins = await rpc('extensionManager/listPlugins')
  if (plugins.ok) {
    const tiers = {}
    for (const p of plugins.value.plugins) tiers[p.tier] = (tiers[p.tier] || 0) + 1
    console.log(`plugins: total=${plugins.value.plugins.length}`, JSON.stringify(tiers))
    for (const p of plugins.value.plugins.filter((x) => x.tier === 'locked').slice(0, 6)) console.log(`   locked: ${p.name}`)
    for (const p of plugins.value.plugins.filter((x) => x.tier !== 'locked').slice(0, 5)) console.log(`   ${p.tier}: ${p.name} (${p.phase})`)
  } else console.log('plugins error:', JSON.stringify(plugins.error))
}
