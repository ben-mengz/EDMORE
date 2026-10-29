import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeMcp, publicMcp, mcpPatch } from '../mcp-settings.mjs'
import { PluginManager } from '../plugins.mjs'

const input = { id: 'example', kind: 'standard', transport: 'streamable-http', url: 'http://127.0.0.1:8020/mcp', enabled: true }
test('validates addresses, namespaces, transports and preserves or clears headers', () => {
  const row = normalizeMcp({ ...input, secrets: { Authorization: 'Bearer secret' } })
  assert.equal(row.url, input.url)
  assert.equal(normalizeMcp(input, row).headers.Authorization, 'Bearer secret')
  assert.deepEqual(normalizeMcp({ ...input, secrets: {} }, row).headers, {})
  assert.ok(!JSON.stringify(publicMcp(row)).includes('Bearer secret'))
  for (const url of ['file:///etc/passwd','http://user:pass@localhost/mcp','http://localhost/mcp?key=secret']) assert.throws(() => normalizeMcp({ ...input, url }))
  assert.throws(() => normalizeMcp({ ...input, transport: 'stdio' }, undefined, { personal: true }))
  assert.throws(() => normalizeMcp({ ...input, id: 'nionswift' }))
  assert.throws(() => normalizeMcp({ ...input, kind: 'edmore' }))
})
test('compiles the native client and single EDMORE bridge without starting services', () => {
  const rows = [normalizeMcp(input), normalizeMcp({ ...input, id: 'nionswift', kind: 'edmore', url: 'http://localhost:7301' })]
  const patch = mcpPatch(rows, 'test')
  assert.equal(patch[0].insert[0].config.serverName, 'example')
  assert.equal(patch[1].id, 'edmore-mcp-bridge')
  assert.equal(patch[1].config.options.baseUrl, 'http://localhost:7301/')
  assert.equal(mcpPatch([{ ...rows[1], enabled: false }], 'test')[0].disabled, true)
})
test('desktop persists private metadata and patches, and supports update/remove', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'edmore-mcp-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const manager = new PluginManager({ root: '/fixture', node: process.execPath, profile: 'test' }, directory, async () => ({ stdout: JSON.stringify({ rows: [], bundles: [] }) }))
  await manager.saveMcp({ ...input, secrets: { Authorization: 'secret' } })
  assert.ok(!JSON.stringify(await manager.mcpList()).includes('"secret"'))
  await manager.saveMcp({ ...input, url: 'http://localhost:9000/mcp' })
  const patch = JSON.parse(await readFile(manager.path, 'utf8'))
  assert.equal(patch[0].insert[0].config.url, 'http://localhost:9000/mcp')
  assert.equal(patch[0].insert[0].config.headers.Authorization, 'secret')
  assert.equal((await stat(manager.path)).mode & 0o777, 0o600)
  await manager.saveMcp({ id: input.id, remove: true })
  assert.deepEqual((await manager.mcpList()).rows, [])
})
test('existing profile MCP addresses are overridden without duplicate registrations or cleared headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'edmore-profile-mcp-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const baseConfig = { serverName: input.id, transport: 'streamable-http', url: input.url, headers: { Authorization: 'profile-secret' } }
  const manager = new PluginManager({ root: '/fixture', node: process.execPath, profile: 'test' }, directory, async () => ({ stdout: JSON.stringify({ rows: [{ id: 'existing-mcp', mcpServerName: input.id, mcpConfig: baseConfig, mcpConnection: { ...input, secretConfigured: true } }], bundles: [] }) }))
  assert.equal((await manager.mcpList()).rows[0].source, 'profile')
  await manager.saveMcp({ ...input, url: 'http://localhost:9999/mcp' })
  assert.deepEqual(JSON.parse(await readFile(manager.path, 'utf8')), [{ id: 'existing-mcp', disabled: false, config: { ...baseConfig, url: 'http://localhost:9999/mcp' } }])
  assert.ok(!JSON.stringify(await manager.mcpList()).includes('profile-secret'))
  assert.equal((await manager.mcpList()).rows[0].secretConfigured, true)
  await manager.saveMcp({ ...input, secrets: {} })
  assert.deepEqual(JSON.parse(await readFile(manager.path, 'utf8'))[0].config.headers, {})
})
