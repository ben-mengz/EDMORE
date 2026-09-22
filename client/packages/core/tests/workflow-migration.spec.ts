import { expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EdmoreWorkflow } from '../../plan-judge/src/index.ts'
import { SessionStateStore } from '../../session-state/src/core.ts'

it('rejects execution evidence access without the required provider', () => {
  const workflow = new EdmoreWorkflow({} as never, {} as never, '')
  expect(() => workflow['recordExecutionContext']({ workflow_id: 'plan' } as never, 'tool.result', 'test', {})).toThrow('evidence service is required')
})

it('moves legacy plan evidence once, backing up the original plan and retaining event identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'edmore-plan-migration-'))
  try {
    const statePath = join(root, 'plan.json')
    const event = { event_id: 'legacy-result', timestamp: '2026-09-16T00:00:00Z', source: 'edmore-plan-judge', type: 'tool.result', workflow_id: 'parent', session_id: 'one', payload: { call_id: 'call', result: { completed: true } } }
    await writeFile(statePath, JSON.stringify({ version: 1, pending: [{ workflow_id: 'parent', session_id: 'one', steps: [], execution_context: [event] }] }))
    const store = new SessionStateStore(join(root, 'evidence'))
    await store.ready()
    const workflow = new EdmoreWorkflow({} as never, {} as never, '', statePath, 2, undefined, undefined, store)
    await workflow.ready()
    await workflow.migrateLegacyEvidence()
    const snapshot = JSON.parse(await readFile(statePath, 'utf8'))
    expect(snapshot.pending[0].execution_context).toBeUndefined()
    expect(store.evidence('one', ['parent']).event_ids).toContain(event.event_id)
    await workflow.migrateLegacyEvidence()
    expect((await readdir(root)).filter(name => name.includes('before-evidence'))).toHaveLength(1)
    const restoredStore = new SessionStateStore(join(root, 'evidence'))
    await restoredStore.ready()
    expect(restoredStore.evidence('one', ['parent']).digest).toBe(store.evidence('one', ['parent']).digest)
  } finally { await rm(root, { recursive: true, force: true }) }
})
