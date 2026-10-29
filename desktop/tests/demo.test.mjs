import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Demo } from '../demo.mjs'

function fixture(mode = 'ready') {
  let launches = 0
  const demo = new Demo({ exists: () => true, startupMs: 50, stopMs: 100, launch() {
    launches++
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('exit', 0)))
    queueMicrotask(() => {
      if (mode === 'ready') child.stdout.write(JSON.stringify({ phase: 'running', twin: 'external', viewer: 'external' }) + '\n')
      if (mode === 'error') child.stdout.write(JSON.stringify({ phase: 'error', detail: 'Port conflict' }) + '\n')
    })
    return child
  } })
  return { demo, launches: () => launches }
}
const clientRoot = '/fixture/EDMORE/client'
test('TEM demo uses its own virtualenv and runner and cannot switch a running demo', async () => {
  const { demo } = fixture()
  const launch = demo.launch
  let args
  demo.launch = (...values) => { args = values; return launch(...values) }
  await demo.start(clientRoot, 'tem')
  assert.match(args[0], /TEM_digital_twin\/tem_twin_autoscript\/\.venv\//)
  assert.match(args[1][1], /tem-demo-runner\.py$/)
  await assert.rejects(demo.start(clientRoot, 'asyncroscopy'), /Stop the current demo/)
  await demo.stop()
  assert.equal(demo.state.phase, 'stopped')
})
test('Demo starts once and releases its runner without adopting external services', async () => {
  const { demo, launches } = fixture()
  await demo.start(clientRoot)
  await demo.start(clientRoot)
  assert.equal(launches(), 1)
  assert.equal(demo.state.twin, 'external')
  await demo.stop()
  assert.equal(demo.child, undefined)
  assert.equal(demo.state.phase, 'stopped')
})
test('Demo failure and startup timeout clean up the runner', async () => {
  for (const mode of ['error', 'timeout']) {
    const { demo } = fixture(mode)
    await assert.rejects(demo.start(clientRoot), /Port conflict|timed out/)
    assert.equal(demo.child, undefined)
    assert.equal(demo.state.phase, 'error')
  }
})
