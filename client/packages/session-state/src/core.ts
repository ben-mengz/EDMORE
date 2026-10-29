import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export interface StateEvent {
  event_id: string
  timestamp: string
  source: string
  type: string
  session_id?: string
  workflow_id?: string
  step_id?: string
  correlation_id?: string
  payload: unknown
}

interface JournalRecord { version: number; event: StateEvent }
interface StoredRecord { version: number; event?: StateEvent; core_event?: { event_id: string; sha256: string } }
interface WorkflowState {
  recovery?: { event_id: string; status: string; payload: unknown }
  status: string
  last_event_id: string
  step_id?: string
  reason?: unknown
  gates: Record<string, { event_id: string; user_reply?: unknown; confirmation_context?: unknown; status?: string; observation?: unknown; review_version?: unknown }>
  assessments: Array<{ event_id: string; payload: unknown }>
  calls: Record<string, { step_id?: string; tool_name?: string; arguments?: unknown; result?: unknown; call_event_id?: string; result_event_id?: string }>
}

const object = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

function modelView(value: unknown, depth = 0): unknown {
  const serialized = JSON.stringify(value) ?? ''
  if (depth > 6) return { omitted: true, sha256: hash(serialized), chars: serialized.length }
  if (typeof value === 'string') return value.length > 2000 ? { excerpt: value.slice(0, 2000), truncated: true, chars: value.length, sha256: hash(value) } : value
  if (Array.isArray(value)) return value.length > 12
    ? { items: value.slice(-12).map(item => modelView(item, depth + 1)), omitted_count: value.length - 12 }
    : value.map(item => modelView(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(-30).map(([key, item]) => [key,
      ['skill_snapshot', 'skill_evidence', 'instructions', 'execution_context', 'child_events', 'child_evidence'].includes(key)
        ? { omitted: true, sha256: hash(JSON.stringify(item) ?? '') }
        : modelView(item, depth + 1)]))
  }
  return value
}

// Export filtering is deliberately separate from the private, lossless journal.
export function redact(value: unknown, key = ''): unknown {
  if (/api.?key|authorization|password|secret|credential|access.?token|refresh.?token/i.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/\bsk-[\w-]+/g, '[REDACTED]')
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value && typeof value === 'object') {
    const row = object(value)
    if (['image', 'audio'].includes(row.type) && typeof row.data === 'string') {
      return { type: row.type, mimeType: row.mimeType, attachment_sha256: hash(row.data), embedded_data_omitted: true }
    }
    return Object.fromEntries(Object.entries(row).map(([name, item]) => [name, redact(item, name)]))
  }
  return value
}

export class SessionStateStore {
  private records: JournalRecord[] = []
  private ids = new Set<string>()
  private chain: Promise<void> = Promise.resolve()
  private failure?: Error
  private initialized = false
  private snapshotVersion = -1
  private listeners = new Set<(event: StateEvent, version: number) => void>()
  subscribe(listener: (event: StateEvent, version: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  constructor(readonly root: string, private resolveCoreEvent?: (eventId: string) => StateEvent | undefined) {}

  private storageRecord(row: JournalRecord): StoredRecord {
    const event = this.resolveCoreEvent?.(row.event.event_id)
    if (event && isDeepStrictEqual(event, row.event)) return { version: row.version, core_event: { event_id: event.event_id, sha256: hash(JSON.stringify(event)) } }
    return row
  }

  async ready(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    let data = ''
    try { data = await readFile(join(this.root, 'events.jsonl'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let migrate = false
    for (const line of data.split('\n').filter(Boolean)) {
      const stored = JSON.parse(line) as StoredRecord
      const referenced = stored.core_event ? this.resolveCoreEvent?.(stored.core_event.event_id) : undefined
      if (stored.core_event && (!referenced || hash(JSON.stringify(referenced)) !== stored.core_event.sha256)) throw new Error(`Core event reference missing or changed: ${stored.core_event.event_id}; evidence cannot be restored`)
      const record = { version: stored.version, event: stored.core_event ? referenced! : stored.event! }
      if (record.version !== this.records.length + 1 || typeof record.event?.event_id !== 'string') throw new Error('Invalid session-state journal; refusing to silently discard evidence.')
      this.records.push(record)
      this.ids.add(this.key(record.event))
      if (!stored.core_event && this.storageRecord(record).core_event) migrate = true
    }
    if (migrate) {
      const token = randomUUID()
      await writeFile(join(this.root, `events.before-core-refs-${token}.jsonl`), data, { mode: 0o600, flag: 'wx' })
      const temporary = join(this.root, `events.${token}.tmp`)
      await writeFile(temporary, this.records.map(row => JSON.stringify(this.storageRecord(row))).join('\n') + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(this.root, 'events.jsonl'))
    }
    this.initialized = true
  }

  private key(event: StateEvent) { return JSON.stringify([event.event_id, event.type, event.workflow_id ?? '', event.session_id ?? '']) }

  record(event: StateEvent): void {
    if (!this.initialized) throw new Error('Session-state store is not ready')
    if (this.failure) throw this.failure
    const key = this.key(event)
    if (this.ids.has(key)) return
    const row = { version: this.records.length + 1, event: structuredClone(event) }
    this.ids.add(key)
    this.records.push(row)
    this.chain = this.chain.then(async () => {
      await appendFile(join(this.root, 'events.jsonl'), `${JSON.stringify(this.storageRecord(row))}\n`, { mode: 0o600 })
    }).catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)) })
    for (const listener of this.listeners) {
      try { Promise.resolve(listener(structuredClone(row.event), row.version)).catch(error => console.error('Evidence subscriber failed:', error)) }
      catch (error) { console.error('Evidence subscriber failed:', error) }
    }
  }

  async flush(): Promise<void> {
    await this.chain
    if (this.failure) throw this.failure
    if (this.snapshotVersion === this.records.length) return
    const snapshot = { schema_version: 1, version: this.records.length, sessions: this.sessions().map(id => this.state(id)) }
    const temporary = join(this.root, `state.${process.pid}.tmp`)
    // Serialize snapshot replacements with journal writes, including concurrent API reads.
    this.chain = this.chain.then(async () => {
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 })
      await rename(temporary, join(this.root, 'state.json'))
      this.snapshotVersion = snapshot.version
    }).catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)) })
    await this.chain
    if (this.failure) throw this.failure
  }

  sessions(): string[] {
    return [...new Set(this.records.flatMap(row => row.event.session_id ? [row.event.session_id] : []))]
  }

  events(sessionId: string, after = 0, limit = 100, through = this.records.length): JournalRecord[] {
    return structuredClone(this.records.filter(row => row.version > after && row.version <= through && row.event.session_id === sessionId)
      .slice(0, Math.min(1000, Math.max(1, limit))))
  }

  state(sessionId: string, through = this.records.length) {
    const workflows: Record<string, WorkflowState> = {}
    for (const row of this.records) {
      if (row.version > through || row.event.session_id !== sessionId) continue
      const event = row.event
      if (!event.workflow_id) continue
      const payload = object(event.payload)
      const state = workflows[event.workflow_id] ??= { status: 'observed', gates: {}, calls: {}, assessments: [], last_event_id: event.event_id }
      state.last_event_id = event.event_id
      const step = event.step_id ?? payload.step_id ?? object(payload.step).step_id
      if (step !== undefined) state.step_id = String(step)
      const statuses: Record<string, string> = {
        'edmore.approval.requested': 'awaiting_approval', 'edmore.workflow.started': 'running',
        'edmore.workflow.resumed': 'running', 'edmore.workflow.paused': 'paused',
        'edmore.workflow.completed': 'completed', 'edmore.workflow.cancelled': 'cancelled',
        'edmore.workflow.failed': 'failed', 'edmore.approval.rejected': 'rejected',
      }
      const trusted = ['edmore-client-api', 'edmore-plan-judge', 'edmore-plan-judge-loop', 'edmore-result-judge'].includes(event.source)
      if (trusted && statuses[event.type] && state.status !== 'cancelled') state.status = statuses[event.type]
      if (trusted && ['recovery.choice.requested', 'recovery.choice.accepted', 'recovery.fix.completed', 'recovery.check.passed'].includes(event.type)) {
        state.recovery = { event_id: event.event_id, status: event.type, payload: event.payload }
      }
      if (trusted && state.recovery && ['edmore.workflow.completed', 'edmore.workflow.cancelled', 'edmore.workflow.failed'].includes(event.type)) state.recovery.status = state.status
      if (payload.reason !== undefined) state.reason = payload.reason
      if (event.type === 'user.resume.accepted' && event.source === 'edmore-client-api' && event.step_id) {
        state.gates[event.step_id] = { event_id: event.event_id, user_reply: payload.user_reply, confirmation_context: payload.confirmation_context }
      }
      if (event.type === 'edmore.workflow.paused' && trusted && object(payload.step).kind === 'confirmation' && step !== undefined) {
        state.gates[String(step)] = { event_id: event.event_id, status: 'awaiting_confirmation', observation: payload.confirmation, review_version: payload.review_version }
      }
      if (event.type === 'edmore.custom.step_result.judged' && trusted) state.assessments.push({ event_id: event.event_id, payload: event.payload })
      if (['tool.call', 'tool.result'].includes(event.type) && typeof payload.call_id === 'string') {
        const call = state.calls[payload.call_id] ??= {}
        call.step_id = event.step_id
        call.tool_name = payload.tool_name
        if (event.type === 'tool.call') { call.arguments = payload.arguments; call.call_event_id = event.event_id }
        else { call.result = payload.result; call.result_event_id = event.event_id }
      }
    }
    return structuredClone({ schema_version: 1, session_id: sessionId, version: through, workflows })
  }

  stepResult(sessionId: string, workflowId: string, stepId: string): unknown {
    for (const row of [...this.records].reverse()) {
      const event = row.event
      if (event.session_id !== sessionId || event.workflow_id !== workflowId || event.step_id !== stepId) continue
      if (event.type === 'tool.result') return structuredClone(object(event.payload).result)
      if (event.type === 'tool.call') return { isError: true, incomplete: true }
    }
    return undefined
  }

  evidence(sessionId: string, workflowIds: string[], through = this.records.length) {
    const ids = new Set(workflowIds)
    const relevant = this.records.filter(row => row.version <= through && row.event.session_id === sessionId
      && row.event.workflow_id && ids.has(row.event.workflow_id)
      && !row.event.type.includes('.delta') && !row.event.type.includes('.context.used'))
    const selected: JournalRecord[] = []
    let remaining = 16000
    for (const row of relevant.slice(-30).reverse()) {
      const compact = { ...row, event: { ...row.event, payload: modelView(row.event.payload) } }
      const size = JSON.stringify(compact).length
      if (size > remaining) continue
      selected.unshift(compact)
      remaining -= size
    }
    const fullState = this.state(sessionId, through)
    let stateBudget = 12000
    const packet = { schema_version: 1, projection_version: 3, version: through, session_id: sessionId,
      state: { ...fullState, workflows: Object.fromEntries(Object.entries(fullState.workflows).filter(([id]) => ids.has(id)).map(([id, workflow]) => {
        const compact = modelView(workflow) as WorkflowState
        const size = JSON.stringify(compact).length
        if (size <= stateBudget) { stateBudget -= size; return [id, compact] }
        return [id, { status: workflow.status, step_id: workflow.step_id, last_event_id: workflow.last_event_id, details_omitted: true }]
      })) },
      event_ids: selected.map(row => row.event.event_id), omitted_event_count: relevant.length - selected.length,
      events: selected }
    return structuredClone({ ...packet, digest: hash(JSON.stringify(packet)) })
  }

  exportTrajectory(sessionId: string): string {
    const events = this.records.filter(row => row.event.session_id === sessionId)
    return [JSON.stringify({ schema: 'edmore.session-trajectory', schema_version: 1, session_id: sessionId,
      version: this.records.length, review_required: true, labels: null,
      notice: 'Credential filtering is best-effort. Review personal data, free text and attachment references before training or sharing.' }),
    ...events.map(row => JSON.stringify(redact(row)))].join('\n') + '\n'
  }

  readEvidence(sessionId: string, eventId?: string, after = 0, offset = 0) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid evidence cursor')
    if (eventId) {
      const row = this.records.find(row => row.event.session_id === sessionId && row.event.event_id === eventId)
      if (!row) throw new Error('Evidence event not found in this conversation')
      const text = JSON.stringify(row)
      return { event_id: eventId, text: text.slice(offset, offset + 12000), offset,
        next_offset: offset + 12000 < text.length ? offset + 12000 : null }
    }
    const rows = this.records.filter(row => row.version > after && row.event.session_id === sessionId
      && !row.event.type.includes('.delta') && !row.event.type.includes('heartbeat') && !row.event.type.includes('.context.used')).slice(0, 30)
    return { events: rows.map(({ version, event }) => ({ version, event_id: event.event_id,
      type: event.type, workflow_id: event.workflow_id, step_id: event.step_id, timestamp: event.timestamp })),
      next_after: rows.at(-1)?.version ?? after }
  }
}
