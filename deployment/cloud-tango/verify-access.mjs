import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Accounts } from '../../client/packages/auth/src/store.mjs'
import { TangoAccess, assertion } from '../../client/packages/plugin-tango/src/access.mjs'
import { Client } from '../../client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StreamableHTTPClientTransport } from '../../client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'

const access = new TangoAccess('/tango-access/harness-access.json')
const config = await access.config()
const accounts = new Accounts('/data/auth/accounts.json')
const users = await accounts.users.list()
const admin = users.find(user => user.isAdmin && !user.disabled)
assert.ok(admin)
const inventory = await access.devices(admin, undefined, () => users)
assert.ok(inventory.admin)
assert.ok(inventory.devices.some(item => item.unclaimed))
const ordinary = users.find(user => !user.isAdmin && !user.disabled) ?? { username: 'deployment-probe', createdAt: 'deployment-probe', isAdmin: false }
const privateInventory = await access.devices(ordinary, undefined, () => users)
assert.deepEqual(privateInventory.devices, [])
for (const user of [admin, ordinary]) {
  const client = new Client({ name: 'deployment-read-only-probe', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${assertion(config, user, 'tango-mcp')}` }, signal: AbortSignal.timeout(10000) },
    }))
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map(tool => tool.name), ['list_devices'])
    const result = await client.callTool({ name: 'list_devices', arguments: {} })
    assert.deepEqual((result.structuredContent ?? JSON.parse(result.content[0].text)).devices, [])
  } finally { await client.close().catch(() => {}) }
}
const policy = JSON.parse(await readFile('/data/auth/admin/settings.json', 'utf8'))
assert.equal(policy.mcp.some(row => row.id === 'tem_twin'), false)
console.log(JSON.stringify({ ok: true, unassignedDevices: inventory.devices.filter(item => item.unclaimed).map(item => item.device), ordinaryDevices: privateInventory.devices.length, legacySharedMcpRemoved: true, hardwareCommandsExecuted: 0 }))
