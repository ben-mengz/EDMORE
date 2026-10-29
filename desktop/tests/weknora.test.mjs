import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeKnora } from '../weknora.mjs'

test('native deployment path and private Harness settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weknora-settings-'))
  try {
    const backend = new WeKnora(join(root, 'EDMORE/client'))
    assert.equal(backend.root, join(root, 'WeKnora-local'))
    await mkdir(backend.root)
    assert.deepEqual(await backend.environment(), {})
    await backend.configure({ apiKey: 'test-key', knowledgeBaseId: 'kb-1' })
    await backend.configure({ apiKey: '', knowledgeBaseId: 'kb-2' })
    const env = await backend.environment()
    assert.equal(env.WEKNORA_API_KEY, 'test-key')
    assert.equal(env.WEKNORA_CAPABILITIES_KB_ID, 'kb-2')
    assert.equal((await stat(join(backend.root, 'harness.env'))).mode & 0o777, 0o600)
    await assert.rejects(backend.configure({ apiKey: 'x\nINJECTED=y', knowledgeBaseId: 'kb' }))
    assert.ok(!(await readFile(join(backend.root, 'harness.env'), 'utf8')).includes('INJECTED'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('does not own or stop externally running service', async () => {
  const backend = new WeKnora('/tmp/EDMORE/client', { launch: () => assert.fail('must not spawn') })
  backend.health = async () => {}
  assert.equal((await backend.start()).phase, 'external')
  await assert.rejects(backend.stop(), /outside this app/)
})

test('Wiki status exposes only scoped counts and the browser link contains no credentials', async t => {
  const backend = new WeKnora('/tmp/EDMORE/client')
  backend.environment = async () => ({ WEKNORA_API_KEY: 'secret', WEKNORA_CAPABILITIES_KB_ID: 'kb' })
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.headers['X-API-Key'], 'secret')
    if (url.endsWith('/knowledge-bases/kb')) return Response.json({ data: { indexing_strategy: { wiki_enabled: true } } })
    if (url.endsWith('/wiki/stats')) return Response.json({ total_pages: 4, pending_tasks: 2, pending_issues: 1, recent_updates: [{ content: 'private document' }] })
    return Response.json({ data: [
      { channel: 'edmore-capability-sync', parse_status: 'completed' },
      { channel: 'edmore-capability-sync', parse_status: 'processing' },
      { channel: 'edmore-capability-sync', parse_status: 'failed' },
      { channel: 'web', parse_status: 'failed' },
    ], total: 4 })
  })
  assert.deepEqual(await backend.wikiStatus(), { phase: 'enabled', sources: 3, processing: 1, failed: 1, pages: 4, pending: 2, issues: 1 })
  assert.equal(await backend.wikiUrl(), 'http://127.0.0.1:8080/platform/knowledge-bases/kb?tab=wiki')
  backend.health = async () => {}
  backend.wikiStatus = async () => { throw new Error('private response') }
  assert.equal((await backend.refresh()).phase, 'external')
  assert.deepEqual(backend.state.wiki, { phase: 'unavailable' })
})
