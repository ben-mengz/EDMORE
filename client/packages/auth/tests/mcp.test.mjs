import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { AdminSettings } from '../src/admin.mjs'
import { Workers } from '../src/workers.mjs'
import { publicAddress, publicTarget, relayPersonalMcp, deviceAddress, deviceTarget, personalTarget } from '../src/mcp-network.mjs'
import { createServer } from 'node:http'

const input = { id: 'remote', kind: 'standard', transport: 'streamable-http', url: 'https://8.8.8.8/mcp', enabled: false }
test('private device access is pinned to the actual VPN peer, never arbitrary private hosts', async () => {
  assert.equal(deviceAddress('::ffff:172.17.2.3'), '172.17.2.3')
  for (const peer of ['127.0.0.1', '::1', '169.254.169.254', '8.8.8.8', undefined]) assert.equal(deviceAddress(peer), undefined)
  assert.deepEqual(await personalTarget(new URL('http://172.17.2.3:9000/mcp'), '::ffff:172.17.2.3'), { address: '172.17.2.3', family: 4 })
  await assert.rejects(personalTarget(new URL('http://172.17.2.4/mcp'), '172.17.2.3'), /public endpoint/)
  assert.throws(() => deviceTarget(new URL('http://127.0.0.1/mcp'), '172.17.2.3'), /VPN IP/)
})
test('ordinary users register only their own authenticated device, secrets are hidden and metadata cannot be forged', async t => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-device-auth-'))
  const admin = new AdminSettings(resolve('.'), home)
  const workers = new Workers({ home, root: resolve('.'), workspace: join(home, 'work'), shared: [], admin })
  t.after(async () => { await workers.close(); await rm(home, { recursive: true, force: true }) })
  const device = { ...input, url: 'http://172.17.2.3:9000/mcp', secrets: { Authorization: `Bearer ${'x'.repeat(64)}` } }
  await workers.setMcp('alice', device, '172.17.2.3')
  assert.equal((await workers.mcp('alice')).rows[0].deviceAddress, '172.17.2.3')
  assert.ok(!JSON.stringify(await workers.mcp('alice')).includes('x'.repeat(64)))
  assert.equal((await workers.mcp('bob')).rows.length, 0)
  await assert.rejects(workers.setMcp('bob', { ...device, deviceAddress: '172.17.2.3' }, '172.17.2.4'), /public endpoint/)
  await assert.rejects(workers.setMcp('bob', { ...device, secrets: {} }, '172.17.2.3'), /Bearer/)
  await workers.setMcp('alice', { ...input, deviceAddress: '172.17.2.3' })
  assert.equal((await workers.mcp('alice')).rows[0].deviceAddress, undefined)
})
test('personal endpoints reject local, metadata, mapped and rebinding destinations', async () => {
  for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.100.100.200','::1','::ffff:127.0.0.1','fc00::1','2002:7f00:1::']) assert.equal(publicAddress(ip), false, ip)
  assert.equal(publicAddress('8.8.8.8'), true)
  assert.equal(publicAddress('2606:4700:4700::1111'), true)
  await assert.rejects(publicTarget(new URL('https://example.org'), async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), /public endpoint/)
})
test('personal MCP proxy pins the target, preserves protocol headers and blocks redirects', async t => {
  let received, redirect = false
  const remote = createServer((req, res) => {
    received = req.headers
    if (redirect) { res.writeHead(307, { location: 'http://127.0.0.1/internal' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' }); res.end('{"tools":[]}')
  })
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve))
  const row = { ...input, url: `http://mcp.example.test:${remote.address().port}/mcp`, headers: { Authorization: 'personal-secret' } }
  const proxy = createServer((req, res) => { void relayPersonalMcp(req, res, row, '', async () => ({ address: '127.0.0.1', family: 4 })).catch(() => { res.writeHead(502); res.end() }) })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => proxy.close(resolve)); await new Promise(resolve => remote.close(resolve)) })
  const endpoint = `http://127.0.0.1:${proxy.address().port}`
  const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'worker-secret', cookie: 'session=private', 'mcp-session-id': 'prior-session' }, body: '{}' })
  assert.equal(response.status, 200); assert.equal(response.headers.get('mcp-session-id'), 'fixture-session')
  assert.deepEqual(await response.json(), { tools: [] })
  assert.equal(received.authorization, 'personal-secret'); assert.equal(received.cookie, undefined)
  assert.equal(received['mcp-session-id'], 'prior-session')
  assert.match(received.host, /^mcp\.example\.test:/)
  redirect = true
  const rejected = await fetch(endpoint)
  assert.equal(rejected.status, 502); await rejected.text()
})
test('personal settings are isolated, HTTP-only, redact secrets and respect shared names', async t => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-mcp-auth-'))
  const admin = new AdminSettings(resolve('.'), home)
  const workers = new Workers({ home, root: resolve('.'), workspace: join(home, 'work'), shared: [], admin })
  t.after(async () => { await workers.close(); await rm(home, { recursive: true, force: true }) })
  await workers.setMcp('alice', { ...input, secrets: { Authorization: 'private-key' } })
  assert.equal((await workers.mcp('bob')).rows.length, 0)
  assert.ok(!JSON.stringify(await workers.mcp('alice')).includes('private-key'))
  await assert.rejects(workers.setMcp('alice', { ...input, url: 'http://127.0.0.1/mcp' }), /public endpoint/)
  await assert.rejects(workers.setMcp('alice', { ...input, transport: 'stdio', command: 'sh', args: [] }), /HTTP only/)
  await admin.saveMcp({ ...input, enabled: true, scope: 'shared', secrets: { Authorization: 'shared-key' } }, 'admin')
  assert.equal((await workers.mcp('alice')).rows[0].shadowed, true)
  assert.ok(!JSON.stringify(await workers.mcp('alice')).includes('shared-key'))
  await assert.rejects(workers.setMcp('alice', input), /managed by the administrator/)
  await workers.setMcp('alice', { id: input.id, remove: true })
  assert.equal((await workers.mcp('alice')).rows.length, 0)
})
test('shared connections reach users, legacy administrator scope stays private, collisions favor admin', async t => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-mcp-scope-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const admin = new AdminSettings(resolve('.'), home)
  await admin.saveMcp({ ...input, id: 'private', enabled: true }, 'admin')
  await admin.saveMcp({ ...input, enabled: true, scope: 'shared' }, 'admin')
  const settings = await admin.workerSettings(join(home, 'alice'), home, false, {}, false, [{ ...input, enabled: true, url: 'https://personal.invalid/mcp' }])
  const patch = JSON.parse(await readFile(settings.path, 'utf8'))
  const entries = patch.flatMap(row => row.insert ?? [])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].config.serverName, 'remote')
  assert.equal(entries[0].config.url, input.url)
})
