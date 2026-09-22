import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Supervisor, readHealth } from '../supervisor.mjs'

test('shows generic MCP registrations beside NionSwift and removes stale entries', async t => {
  let tools = [{ name: 'mcp__asyncroscopy__acquire' }, { name: 'mcp__asyncroscopy__stage' }, { name: 'mcp__nionswift_sem__scan' }]
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, tools: req.url.includes('/harness/') ? tools : [{}] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const supervisor = new Supervisor({ baseUrl: `http://127.0.0.1:${server.address().port}` }, {
    health: async () => ({ nionswift: { ok: true, agents: ['sem'] } }),
  })
  await supervisor.refresh()
  await supervisor.probeMcp()
  assert.equal(supervisor.state.mcp.find(r => r.name === 'sem').status, 'reachable')
  assert.equal(supervisor.state.mcp.find(r => r.name === 'asyncroscopy').tools, 2)
  await supervisor.refresh()
  assert.equal(supervisor.state.mcp.find(r => r.name === 'asyncroscopy').status, 'registered')
  tools = []
  await supervisor.probeMcp()
  assert.equal(supervisor.state.mcp.length, 1)
})

function fixture(t) {
  let port, launches = 0
  const supervisor = new Supervisor({ node: process.execPath, root: process.cwd(), profile: 'fixture', baseUrl: 'unused' }, {
    launch() {
      launches++
      port = undefined
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixture.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      child.on('message', message => { port = message.port })
      t.after(() => { if (child.exitCode === null) child.kill() })
      return child
    },
    health: async () => { if (!port) throw new Error('not ready'); return readHealth(`http://127.0.0.1:${port}`) },
    startupMs: 3000, stopMs: 2000,
  })
  return { supervisor, launches: () => launches }
}

test('starts one child, stops it through IPC, then restarts with a fresh process', async t => {
  const { supervisor, launches } = fixture(t)
  await Promise.all([supervisor.start(), supervisor.start()])
  assert.equal(launches(), 1)
  assert.equal(supervisor.state.phase, 'running')
  const pid = supervisor.child.pid
  await supervisor.refresh()
  assert.deepEqual(supervisor.state.mcp, [{ name: 'test_mcp', status: 'discovered' }])
  await supervisor.restart()
  assert.equal(supervisor.state.phase, 'running')
  assert.notEqual(supervisor.child.pid, pid)
  await supervisor.stop()
  assert.equal(supervisor.state.phase, 'stopped')
  assert.equal(supervisor.state.owned, false)
  assert.equal(supervisor.child, undefined)
})

test('detects a crash and allows recovery', async t => {
  const { supervisor } = fixture(t)
  await supervisor.start()
  const exit = once(supervisor.child, 'exit')
  supervisor.child.kill('SIGKILL')
  await exit
  assert.equal(supervisor.state.phase, 'error')
  await supervisor.start()
  assert.equal(supervisor.state.phase, 'running')
  await supervisor.stop()
})

test('does not duplicate or stop an externally owned server', async () => {
  const supervisor = new Supervisor({ baseUrl: 'unused' }, {
    health: async () => ({ ok: true }), launch: () => assert.fail('must not spawn'),
  })
  await supervisor.start()
  assert.equal(supervisor.state.phase, 'external')
  await supervisor.stop()
  assert.equal(supervisor.state.phase, 'external')
  await assert.rejects(supervisor.restart(), /Only a EDMORE client/)
})

test('reports a missing executable without leaving a phantom owned child', async () => {
  const supervisor = new Supervisor({ node: '/missing/edmore-node', root: process.cwd(), profile: 'fixture', baseUrl: 'unused' }, {
    health: async () => { throw new Error('offline') }, startupMs: 1000,
  })
  await supervisor.start()
  assert.equal(supervisor.state.phase, 'error')
  assert.equal(supervisor.state.owned, false)
  assert.match(supervisor.state.error, /ENOENT/)
})
