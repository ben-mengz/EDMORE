import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { Supervisor } from '../supervisor.mjs'
import { PluginManager } from '../plugins.mjs'

// Isolate persistence and disable instrument connectivity for lifecycle verification.
const home = mkdtempSync(join(tmpdir(), 'edmore-profile-smoke-'))
const root = resolve('../client')
process.env.DSH_HOME = home
process.env.EDMORE_NIONSWIFT_BASE_URL = 'http://127.0.0.1:1'
const supervisor = new Supervisor({ root, node: process.execPath, profile: 'edmore-client', baseUrl: 'http://127.0.0.1:17483' }, { startupMs: 20000 })
try {
  const plugins = new PluginManager(supervisor.config, join(home, 'desktop'))
  await plugins.toggle('edmore-conversation-title', false)
  supervisor.config.pluginPatch = await plugins.writePatch()
  await supervisor.start()
  assert.equal(supervisor.state.phase, 'running', supervisor.state.logs + supervisor.state.error)
  const first = supervisor.child.pid
  await supervisor.restart()
  assert.equal(supervisor.state.phase, 'running', supervisor.state.logs + supervisor.state.error)
  assert.notEqual(first, supervisor.child.pid)
  await supervisor.stop()
  assert.equal(supervisor.state.phase, 'stopped')
  console.log('Real EDMORE profile: start / restart / graceful IPC stop passed; isolated data, instrument offline.')
} finally {
  if (supervisor.child) { supervisor.child.kill('SIGTERM'); await supervisor.exited }
  rmSync(home, { recursive: true, force: true })
}
