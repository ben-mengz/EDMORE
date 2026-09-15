import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { loadDesktopConfig, isClientRoot } from '../config.mjs'

test('migrates the previous checkout and plugin choices to EDMORE client only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'edmore-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = join(root, 'data'), client = join(root, 'EDMORE/client')
  await mkdir(data)
  await mkdir(client, { recursive: true })
  for (const name of ['start.mjs', 'profile.mjs']) await writeFile(join(client, name), '')
  const previous = { root: join(root, 'deepseek-harness'), node: process.execPath, profile: 'edmore-backend', baseUrl: 'http://127.0.0.1:17380' }
  await writeFile(join(data, 'harness.json'), JSON.stringify(previous))
  const key = value => createHash('sha256').update(JSON.stringify([value.root, value.profile, process.env.DSH_HOME ?? ''])).digest('hex').slice(0, 20)
  const choices = { added: [], disabled: { 'llm-deepseek': true }, packages: [] }
  await mkdir(join(data, 'plugins', key(previous)), { recursive: true })
  await writeFile(join(data, 'plugins', key(previous), 'plugins.json'), JSON.stringify(choices))
  const { config } = await loadDesktopConfig(data, '')
  assert.equal(config.root, client)
  assert.equal(config.profile, 'edmore-client')
  assert.equal(config.baseUrl, previous.baseUrl)
  assert.equal(isClientRoot(previous.root), false)
  assert.deepEqual(JSON.parse(await readFile(join(data, 'plugins', key(config), 'plugins.json'))), choices)
  assert.deepEqual((await loadDesktopConfig(data, '')).config, config)
})
