import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { SessionStateStore, redact } from '../../session-state/src/core.ts'
import { apply } from '../../session-state-api/src/index.ts'

describe('session-state plugin', () => {
  it('bounds recent evidence and pages exact records without crossing conversations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'edmore-evidence-pages-'))
    const store = new SessionStateStore(root)
    try {
      await store.ready()
      for (let i = 0; i < 40; i++) store.record({ event_id: String(i), timestamp: new Date().toISOString(), source: 'test', type: 'tool.result', session_id: 'one', workflow_id: 'plan', payload: { text: 'x'.repeat(i === 39 ? 25000 : 10) } })
      expect(store.evidence('one', ['plan']).events.length).toBeLessThanOrEqual(30)
      expect(store.readEvidence('one').events).toHaveLength(30)
      expect(() => store.readEvidence('other', '39')).toThrow('not found')
      const first = store.readEvidence('one', '39')
      expect(first.text?.length).toBe(12000)
      expect(first.next_offset).toBe(12000)
      const second = store.readEvidence('one', '39', 0, 12000)
      const third = store.readEvidence('one', '39', 0, 24000)
      expect(JSON.parse(first.text! + second.text! + third.text!).event.payload.text.length).toBe(25000)
    } finally { await store.flush(); await rm(root, { recursive: true, force: true }) }
  })
  it('migrates duplicate Core events to checked references with backup and unchanged evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'edmore-evidence-migration-'))
    const event = { event_id: 'core-event', timestamp: '2026-09-16T00:00:00Z', source: 'test', type: 'edmore.custom.note', session_id: 'one', workflow_id: 'plan', payload: { note: 'unchanged evidence' } }
    try {
      const original = new SessionStateStore(root)
      await original.ready()
      original.record(event)
      await original.flush()
      const before = original.evidence('one', ['plan'])
      const resolver = (id: string) => id === event.event_id ? structuredClone(event) : undefined
      const migrated = new SessionStateStore(root, resolver)
      await migrated.ready()
      expect(migrated.evidence('one', ['plan'])).toEqual(before)
      const stored = JSON.parse((await readFile(join(root, 'events.jsonl'), 'utf8')).trim())
      expect(stored.event).toBeUndefined()
      expect(stored.core_event.event_id).toBe(event.event_id)
      expect((await readdir(root)).filter(name => name.startsWith('events.before-core-refs-'))).toHaveLength(1)
      await expect(new SessionStateStore(root, () => undefined).ready()).rejects.toThrow('reference missing or changed')
      await expect(new SessionStateStore(root, () => ({ ...event, payload: { note: 'tampered' } })).ready()).rejects.toThrow('reference missing or changed')
      const restored = new SessionStateStore(root, resolver)
      await restored.ready()
      expect(restored.evidence('one', ['plan'])).toEqual(before)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('projects trusted recovery choices and exports their evidence without treating a fix as diagnostic success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'edmore-recovery-state-'))
    try {
      const store = new SessionStateStore(root)
      await store.ready()
      const base = { timestamp: '', session_id: 's', workflow_id: 'w', step_id: '5', source: 'edmore-plan-judge' }
      store.record({ ...base, event_id: 'request', type: 'recovery.choice.requested', payload: { version: 'v1', options: ['fix_a'] } })
      store.record({ ...base, event_id: 'fake', source: 'external-ui', type: 'recovery.check.passed', payload: {} })
      expect(store.state('s').workflows.w.recovery?.status).toBe('recovery.choice.requested')
      store.record({ ...base, event_id: 'fix', type: 'recovery.fix.completed', payload: { call_id: 'call' } })
      expect(store.state('s').workflows.w.recovery?.status).toBe('recovery.fix.completed')
      expect(store.state('s').workflows.w.status).not.toBe('completed')
      store.record({ ...base, event_id: 'check', type: 'recovery.check.passed', payload: { call_id: 'recheck' } })
      expect(store.state('s').workflows.w.recovery?.status).toBe('recovery.check.passed')
      expect(store.exportTrajectory('s')).toContain('fix_a')
      await store.flush()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('bounds model evidence without trimming the raw tool history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'edmore-budget-'))
    try {
      const store = new SessionStateStore(root)
      await store.ready()
      for (let i = 0; i < 30; i++) store.record({ event_id: String(i), timestamp: '', source: 'test',
        type: 'tool.result', session_id: 's', workflow_id: 'w', payload: { call_id: String(i),
          result: { text: 'x'.repeat(20000), skill_snapshot: { instructions: 'y'.repeat(20000) } } } })
      const packet = store.evidence('s', ['w'])
      expect(JSON.stringify(packet).length).toBeLessThan(35000)
      expect(packet.omitted_event_count).toBeGreaterThan(0)
      expect(packet.projection_version).toBe(3)
      expect(JSON.stringify(store.events('s', 0, 100))).toContain('x'.repeat(20000))
      await store.flush()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('replays durable records, isolates sessions, and keeps accepted gates separate from assertions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'edmore-state-'))
    try {
      const store = new SessionStateStore(root)
      await store.ready()
      const event = { event_id: 'button', timestamp: '2026-09-15T00:00:00Z', source: 'nionswift-ui', type: 'user.resume.accepted', session_id: 's1', workflow_id: 'w1', step_id: '4', payload: { user_reply: 'confirmed', confirmation_context: { roi: 12 } } }
      store.record(event)
      expect(store.state('s1').workflows.w1.gates).toEqual({})
      store.record({ ...event, event_id: 'accepted', source: 'edmore-client-api' })
      store.record({ ...event, event_id: 'private', session_id: 's2', payload: { text: 'other-session-secret' } })
      store.record({ ...event, event_id: 'call', type: 'tool.call', payload: { call_id: 'call', tool_name: 'wait', arguments: { seconds: 1 } } })
      store.record({ ...event, event_id: 'result', type: 'tool.result', payload: { call_id: 'call', tool_name: 'wait', result: { text: 'wait complete' } } })
      store.record({ ...event, event_id: 'judge', source: 'edmore-result-judge', type: 'edmore.custom.step_result.judged', payload: { status: 'success', reason: 'Model assessment only' } })
      const packet = store.evidence('s1', ['w1'])
      expect(JSON.stringify(packet)).not.toContain('other-session-secret')
      expect(packet.state.workflows.w1.gates['4'].event_id).toBe('accepted')
      expect(packet.state.workflows.w1.calls.call.arguments).toEqual({ seconds: 1 })
      expect(packet.state.workflows.w1.calls.call.result).toEqual({ text: 'wait complete' })
      expect(packet.state.workflows.w1.status).toBe('observed')
      expect(packet.state.workflows.w1.assessments).toHaveLength(1)
      store.record(event)
      expect(store.evidence('s1', ['w1']).version).toBe(packet.version)
      await Promise.all([store.flush(), store.flush()])
      const restored = new SessionStateStore(root)
      await restored.ready()
      expect(restored.evidence('s1', ['w1'], packet.version)).toEqual(packet)
      expect(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).schema_version).toBe(1)
      expect(store.events('s1', 0, 1)).toHaveLength(1)
      expect(store.events('s1', store.events('s1', 0, 1)[0].version, 1)[0].event.event_id).toBe('accepted')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('exports versioned unlabelled trajectories with credential and inline-image filtering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'edmore-export-'))
    try {
      const store = new SessionStateStore(root)
      await store.ready()
      store.record({ event_id: 'e', timestamp: '', source: 'test', type: 'tool.result', session_id: 's', payload: {
        api_key: 'private-key', text: 'Bearer private-token', content: [{ type: 'image', data: 'inline-image', mimeType: 'image/png' }],
      } })
      const exported = store.exportTrajectory('s')
      expect(exported).not.toContain('private-key')
      expect(exported).not.toContain('private-token')
      expect(exported).not.toContain('inline-image')
      expect(exported).toContain('attachment_sha256')
      expect(JSON.parse(exported.split('\n')[0]).labels).toBeNull()
      expect(redact({ credentials: { password: 'x' } })).toEqual({ credentials: '[REDACTED]' })
      await store.flush()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('registers read-only state, pagination and export endpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'edmore-api-'))
    let handler: any
    let store: SessionStateStore
    const disposers: Array<() => unknown> = []
    try {
      store = new SessionStateStore(root)
      await store.ready()
      await apply({ edmoreSessionState: store, provide() {},
        effect(fn: any) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) }, webServer: { register(route: any) { handler = route.handler; return () => {} } },
      } as any)
      store!.record({ event_id: 'e', timestamp: '', source: 'test', type: 'ui.event', session_id: 's', payload: {} })
      const request = async (url: string, method = 'GET') => {
        const response: any = { statusCode: 200, headers: {}, setHeader(k: string, v: string) { this.headers[k] = v }, end(body: string) { this.body = body } }
        await handler({ url, method }, response)
        return response
      }
      expect(JSON.parse((await request('/api/edmore-session-state/state?session_id=s')).body).session_id).toBe('s')
      expect((await request('/api/edmore-session-state/state')).statusCode).toBe(400)
      expect((await request('/api/edmore-session-state/state?session_id=s', 'POST')).statusCode).toBe(405)
      expect((await request('/api/edmore-session-state/export?session_id=s')).headers['Content-Type']).toContain('ndjson')
      await store!.flush()
    } finally { for (const dispose of disposers) await dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('fails closed on a damaged journal rather than losing evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'edmore-damaged-'))
    try {
      await writeFile(join(root, 'events.jsonl'), '{broken')
      await expect(new SessionStateStore(root).ready()).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
