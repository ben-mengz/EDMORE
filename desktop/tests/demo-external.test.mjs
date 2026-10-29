import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectExternalDemo, stopExternalDemo } from '../demo-external.mjs'

const root = '/fixture/EDMORE/client'
const identity = 'Thu Sep 17 16:49:20 2026 /fixture/asyncroscopy/.venv-twin/bin/python3 -m asyncroscopy.mcp.mcp_server --name AsyncroscopyDigitalTwin --http-host 127.0.0.1 --http-port 8010'
const expected = { pid: 123, identity }
test('identifies only the known local Asyncroscopy MCP process', async () => {
  const run = async name => ({ stdout: name === 'lsof' ? '123\n123\n' : identity })
  assert.deepEqual(await inspectExternalDemo(root, run), expected)
  for (const command of [identity.replace('AsyncroscopyDigitalTwin', 'RealMicroscope'), identity.replace('8010', '8767'), identity.replace('/fixture/asyncroscopy', '/other'), identity.replace('127.0.0.1', '0.0.0.0')]) {
    assert.equal(await inspectExternalDemo(root, async name => ({ stdout: name === 'lsof' ? '123' : command })), null)
  }
  assert.equal(await inspectExternalDemo(root, async () => { throw Object.assign(new Error('no listener'), { code: 1 }) }), null)
  await assert.rejects(inspectExternalDemo(root, async () => { throw Object.assign(new Error('missing lsof'), { code: 'ENOENT' }) }), /missing lsof/)
})
test('stops only the confirmed identity and waits for shutdown', async () => {
  let reads = 0
  const signals = []
  await stopExternalDemo(root, expected, { inspect: async () => ++reads === 1 ? expected : null,
    signal: pid => signals.push(pid), sleep: async () => {} })
  assert.deepEqual(signals, [123])
  for (const current of [null, { ...expected, pid: 124 }, { ...expected, identity: identity + ' changed' }]) {
    await assert.rejects(stopExternalDemo(root, expected, { inspect: async () => current,
      signal: () => assert.fail('must not signal changed process') }), /changed since confirmation/)
  }
})
test('does not force kill or chase a restarted external service', async () => {
  const options = { signal() {}, sleep: async () => {}, attempts: 2 }
  await assert.rejects(stopExternalDemo(root, expected, { ...options, inspect: async () => expected }), /No force kill/)
  let reads = 0
  await assert.rejects(stopExternalDemo(root, expected, { ...options,
    inspect: async () => ++reads === 1 ? expected : { ...expected, pid: 124 } }), /Another Demo MCP started/)
})
