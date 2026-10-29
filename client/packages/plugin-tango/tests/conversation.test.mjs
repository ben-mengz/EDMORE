import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationDevices } from '../src/conversation.mjs'

test('conversation selection persists, isolates conversations and guards explicit targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tango-selection-'))
  try {
    let busy = false
    const inventory = async () => [{ device: 'tem/a/1', available: true }, { device: 'tem/b/2', available: false }]
    const service = new ConversationDevices(join(dir, 'state.json'), inventory, () => busy)
    await service.load()
    assert.ok(service.denial('a', 'mcp__tango__select_device', { device: 'tem/a/1' }))
    await service.select('a', ['tem/a/1'])
    assert.equal(service.denial('a', 'mcp__tango__select_device', { device: 'tem/a/1' }), undefined)
    assert.ok(service.denial('b', 'mcp__tango__select_device', { device: 'tem/a/1' }))
    assert.ok(service.denial('a', 'mcp__tango__run', {}))
    assert.equal(service.denial('b', 'mcp__tango__list_devices', {}), undefined)
    assert.equal(service.denial('b', 'mcp__other__run', {}), undefined)
    await assert.rejects(service.select('a', ['unknown']), /not authorized/)
    await assert.rejects(service.select('a', ['tem/b/2']), /unavailable/)
    busy = true
    await assert.rejects(service.select('a', []), /Finish or cancel/)
    busy = false
    const restored = new ConversationDevices(service.path, inventory)
    await restored.load()
    assert.deepEqual((await restored.snapshot('a')).selected, ['tem/a/1'])
    await restored.select('a', [])
    assert.ok(restored.denial('a', 'mcp__tango__run', { device: 'tem/a/1' }))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('inventory failure is fail-closed and task started during discovery blocks save', async () => {
  let busy = false
  const service = new ConversationDevices('/unused', async () => { busy = true; return [{ device: 'x', available: true }] }, () => busy)
  await assert.rejects(service.select('a', ['x']), /became busy/)
  service.inventory = async () => { throw new Error('private endpoint detail') }
  assert.equal((await service.snapshot('a')).error.includes('private'), false)
  assert.deepEqual((await service.snapshot('a')).selected, [])
})
