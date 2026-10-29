import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workers } from '../src/workers.mjs'
import { writeJson } from '../src/store.mjs'

test('model toggles are per-user, respect admin policy and preserve a usable model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'model-plugins-'))
  let policy = { plugins: {} }
  const workers = new Workers({ root: home, home, workspace: home, shared: [{ id: 'llm3-hu' }, { id: 'bonsai-local' }], admin: { read: async () => policy } })
  try {
    await workers.setPlugin('alice', 'edmore-model-hu', false)
    assert.equal(await workers.modelEnabled('alice', 'llm3-hu'), false)
    assert.equal(await workers.modelEnabled('bob', 'llm3-hu'), true)
    await assert.rejects(workers.setPlugin('alice', 'edmore-model-bonsai', false), /at least one/)
    await assert.rejects(workers.setPlugin('alice', 'edmore-model-strata', true), /unavailable/)
    policy = { plugins: { 'edmore-model-hu': false } }
    await assert.rejects(workers.setPlugin('alice', 'edmore-model-hu', true), /administrator/)
    assert.equal(await workers.modelEnabled('bob', 'llm3-hu'), false)
    await writeJson(join(workers.paths('alice').home, 'edmore/llm-providers.json'), { profiles: [{ id: 'openai' }] })
    await writeJson(join(workers.paths('alice').home, 'edmore/.credentials.yaml'), { refs: { OPENAI_API_KEY: 'test-only' } })
    await workers.setPlugin('alice', 'edmore-model-bonsai', false)
    assert.equal(await workers.modelEnabled('alice', 'bonsai-local'), false)
  } finally { await workers.close(); await rm(home, { recursive: true, force: true }) }
})
