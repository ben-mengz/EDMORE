import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginManager, packageName } from '../plugins.mjs'
import { en, zh } from '../locale.mjs'
import { trayTemplate } from '../menus.mjs'

async function fixture(t, command) {
  const directory = await mkdtemp(join(tmpdir(), 'edmore-plugin-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const operations = []
  const manager = new PluginManager({ root: '/fixture', node: process.execPath, profile: 'test' }, directory, async (_file, args) => {
    operations.push(args.slice(5))
    if (command) return command(args[5], args[6])
    return { stdout: JSON.stringify({ rows: [{ id: 'example', name: 'example-plugin', disabled: false }], bundles: [] }) }
  })
  return { manager, operations }
}

test('saves enable overrides in its own patch and restores the original setting', async t => {
  const { manager } = await fixture(t)
  let result = await manager.toggle('example', false)
  assert.equal(result.rows[0].disabled, true)
  assert.deepEqual(JSON.parse(await readFile(manager.path, 'utf8')), [{ id: 'example', disabled: true }])
  result = await manager.toggle('example', null)
  assert.equal(result.rows[0].disabled, false)
  assert.deepEqual(JSON.parse(await readFile(manager.path, 'utf8')), [])
  await assert.rejects(manager.toggle('unknown', true), /Unknown plugin/)
})

test('registers and removes a desktop-installed plain plugin through the profile CLI', async t => {
  const { manager, operations } = await fixture(t)
  let result = await manager.install('@test/plugin@1.2.3', { mode: 'test' })
  const plugin = result.rows.find(row => row.source === 'desktop')
  assert.equal(plugin.name, '@test/plugin')
  assert.ok(operations.some(([op, spec]) => op === 'add' && spec === '@test/plugin@1.2.3'))
  const patch = JSON.parse(await readFile(manager.path, 'utf8'))
  assert.deepEqual(patch[0].insert[0].config, { mode: 'test' })
  result = await manager.remove(plugin.id)
  assert.equal(result.rows.some(row => row.source === 'desktop'), false)
  assert.ok(operations.some(([op, spec]) => op === 'remove' && spec === '@test/plugin'))
})

test('does not double-register a bundle and permits removing the installed bundle', async t => {
  let installed = false
  const { manager } = await fixture(t, async operation => {
    if (operation === 'add') installed = true
    if (operation === 'remove') installed = false
    return { stdout: JSON.stringify({ rows: [], bundles: installed ? ['example-bundle'] : [] }) }
  })
  const result = await manager.install('example-bundle', {})
  assert.deepEqual(JSON.parse(await readFile(manager.path, 'utf8')), [])
  assert.equal(result.rows[0].kind, 'package')
  await manager.remove(result.rows[0].id)
  assert.equal(installed, false)
})

test('rejects shell flags and metacharacters in package specs', () => {
  for (const value of ['--global', 'x;touch /tmp/x', 'x$(echo y)', 'x&calc', 'x|y', '../x', 'x@1 2']) assert.throws(() => packageName(value))
  assert.equal(packageName('@scope/plugin@next'), '@scope/plugin')
})

test('English and Chinese cover the same controls and tray exit keeps background distinct', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  const actions = []
  const commands = { action: name => actions.push(name), panel() {}, plugins() {}, language() {}, background() {}, quit() {} }
  const stopped = trayTemplate({ phase: 'stopped', owned: false, mcp: [] }, 'en', commands)
  stopped.find(row => row.id === 'harness-toggle').click()
  const running = trayTemplate({ phase: 'running', owned: true, mcp: [] }, 'zh', commands)
  running.find(row => row.id === 'harness-toggle').click()
  assert.deepEqual(actions, ['start', 'stop'])
  assert.notEqual(stopped.find(row => row.id === 'background').click, stopped.find(row => row.id === 'quit-completely').click)
  assert.equal(trayTemplate({ phase: 'external', owned: false, mcp: [] }, 'en', commands).find(row => row.id === 'harness-toggle').enabled, false)
})
