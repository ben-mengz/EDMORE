import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'edmore-client-test-'))
const socket = createServer()
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise(resolve => socket.close(resolve))
const base = `http://127.0.0.1:${port}`
let child, exited, logs = ''
async function start() {
  logs = ''
  child = spawn(process.execPath, ['--import', 'tsx/esm', 'start.mjs'], {
    cwd: root,
    env: { ...process.env, DSH_HOME: home, EDMORE_CLIENT_PORT: String(port),
      EDMORE_NIONSWIFT_BASE_URL: 'http://127.0.0.1:1', EDMORE_WORKSPACE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  exited = new Promise(resolve => child.once('exit', resolve))
  child.stdout.on('data', data => { logs += data })
  child.stderr.on('data', data => { logs += data })
  for (let i = 0; i < 150; i++) {
    try {
      const response = await fetch(`${base}/api/edmore/health`)
      if (response.ok) {
        const health = await response.json()
        assert.equal(health.ok, true)
        assert.equal(health.nionswift.ok, false)
        return
      }
    } catch {}
    if (child.exitCode !== null) break
    await delay(100)
  }
  throw new Error(`Client failed to start:\n${logs}`)
}
async function stop() {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  try { assert.equal(await exited, 0, logs) } finally { clearTimeout(timer) }
}
async function api(path, body) {
  const response = await fetch(base + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal(response.ok, true, await response.clone().text())
  return response.json()
}
try {
  await start()
  const projects = await api('/api/edmore-workspace/projects')
  const project = projects.projects[0]
  assert.ok(project.id)
  const created = await api('/api/edmore-workspace/conversations', { project_id: project.id, title: 'Persistence check' })
  assert.ok(created.conversation.id)
  const skills = await api('/api/edmore/skills')
  assert.ok(JSON.stringify(skills).includes('ptychography'))
  assert.equal((await fetch(`${base}/edmore/`)).status, 200)
  await stop()
  await start()
  const restored = await api(`/api/edmore-workspace/conversations?project_id=${encodeURIComponent(project.id)}`)
  assert.ok(restored.conversations.some(item => item.id === created.conversation.id))
  console.log('PASS: startup, offline MCP, skills, UI, conversation persistence, restart, shutdown')
} finally {
  await stop()
  await rm(home, { recursive: true, force: true })
}
