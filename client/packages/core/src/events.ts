import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EdmoreEvent, EventFilter } from '@deepseek-ai/dsh-edmore-contracts'

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

function requestFingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const canonical = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
  return createHash('sha256').update(canonical).digest('hex')
}

const CORE_EVENTS = new Set([
  'edmore.server.started',
  'edmore.server.heartbeat',
  'edmore.server.stopped',
  'edmore.ui.show',
  'edmore.trigger.requested',
  'edmore.assistant.started',
  'edmore.assistant.delta',
  'edmore.assistant.completed',
  'edmore.assistant.failed',
  'edmore.llm.provider.updated',
  'edmore.llm.provider.selected',
  'edmore.conversation.title.requested',
  'edmore.conversation.title.generated',
  'edmore.conversation.title.failed',
  'edmore.conversation.updated',
  'edmore.plan.generated',
  'edmore.plan.judged',
  'edmore.plan.replan_requested',
  'edmore.approval.requested',
  'edmore.approval.granted',
  'edmore.approval.rejected',
  'edmore.workflow.started',
  'edmore.workflow.paused',
  'edmore.workflow.resumed',
  'edmore.workflow.completed',
  'edmore.workflow.cancelled',
  'edmore.workflow.failed',
  'edmore.hardware.observed',
  'edmore.confirmation.accepted',
  'edmore.instrument.status_changed',
])

const FORBIDDEN_CUSTOM_ACTIONS = new Set([
  'direct_hardware_move',
  'direct_acquire',
  'direct_beam_change',
  'move_stage',
  'start_acquisition',
])

export class EdmoreEventHub {
  private events: EdmoreEvent[] = []
  private byId = new Map<string, EdmoreEvent>()
  private nextCursor = 1
  private subscribers = new Set<(event: EdmoreEvent) => void>()
  private loadPromise: Promise<void>
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private path: string) {
    this.loadPromise = this.load()
  }

  async ready(): Promise<void> {
    await this.loadPromise
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  async append(input: Omit<Partial<EdmoreEvent>, 'event_id' | 'cursor' | 'timestamp'> & Pick<EdmoreEvent, 'type'>): Promise<EdmoreEvent> {
    await this.ready()
    this.validate(input)
    const operation = this.writeChain.then(async () => {
    const event: EdmoreEvent = {
      event_id: randomUUID(),
      cursor: this.nextCursor,
      timestamp: new Date().toISOString(),
      source: input.source ?? 'edmore-harness',
      type: input.type,
      scope: input.scope ?? 'global',
      ...input.session_id === undefined ? {} : { session_id: input.session_id },
      ...input.workflow_id === undefined ? {} : { workflow_id: input.workflow_id },
      ...input.server_id === undefined ? {} : { server_id: input.server_id },
      ...input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id },
      payload: input.payload ?? {},
    }
    const snapshot = JSON.stringify(event)
    const committed = JSON.parse(snapshot) as EdmoreEvent
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(temporary, `${[...this.events.map(item => JSON.stringify(item)), snapshot].join('\n')}\n`, 'utf8')
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
    this.events.push(committed)
    this.byId.set(committed.event_id, committed)
    this.nextCursor++
    for (const subscriber of this.subscribers) {
      try {
        Promise.resolve(subscriber(structuredClone(committed))).catch(error => console.error('EDMore event subscriber failed:', error))
      } catch (error) {
        console.error('EDMore event subscriber failed:', error)
      }
    }
    return structuredClone(committed)
    })
    // A rejected write is reported to its caller, but must not poison later writes.
    this.writeChain = operation.then(() => {}, () => {})
    return operation
  }

  query(filter: EventFilter = {}): EdmoreEvent[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
    const matches = this.events
      .filter(event => filter.after === undefined || event.cursor > filter.after)
      .filter(event => filter.scope === undefined || event.scope === filter.scope)
      .filter(event => filter.session_id === undefined || event.session_id === filter.session_id)
      .filter(event => filter.workflow_id === undefined || event.workflow_id === filter.workflow_id)
      .filter(event => filter.server_id === undefined || event.server_id === filter.server_id)
    return structuredClone(filter.after === undefined ? matches.slice(-limit) : matches.slice(0, limit))
  }

  subscribe(listener: (event: EdmoreEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => { this.subscribers.delete(listener) }
  }

  matches(event: EdmoreEvent, filter: EventFilter): boolean {
    return (filter.after === undefined || event.cursor > filter.after)
      && (filter.scope === undefined || event.scope === filter.scope)
      && (filter.session_id === undefined || event.session_id === filter.session_id)
      && (filter.workflow_id === undefined || event.workflow_id === filter.workflow_id)
      && (filter.server_id === undefined || event.server_id === filter.server_id)
  }

  findLastByCorrelation(correlationId: string, type: string): EdmoreEvent | undefined {
    const event = this.events.findLast(event => event.correlation_id === correlationId && event.type === type)
    return event === undefined ? undefined : structuredClone(event)
  }

  findById(eventId: string): EdmoreEvent | undefined {
    const event = this.byId.get(eventId)
    return event === undefined ? undefined : structuredClone(event)
  }

  private validate(input: Pick<EdmoreEvent, 'type'> & Partial<EdmoreEvent>): void {
    const type = input.type
    if (!CORE_EVENTS.has(type) && !type.startsWith('user.') && !type.startsWith('edmore.custom.')) {
      throw new Error(`edmore event type is not allowed: ${type}`)
    }
    if (type.startsWith('user.') || type.startsWith('edmore.custom.')) {
      const payload = input.payload as { action?: unknown } | undefined
      if (typeof payload?.action === 'string' && FORBIDDEN_CUSTOM_ACTIONS.has(payload.action)) {
        throw new Error(`custom event cannot directly request hardware action: ${payload.action}`)
      }
    }
  }

  private async load(): Promise<void> {
    let body = ''
    try {
      body = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const loaded: EdmoreEvent[] = []
    const ids = new Set<string>()
    for (const [index, line] of body.split('\n').entries()) {
      const text = line.trim()
      if (text.length === 0) continue
      try {
        const event = JSON.parse(text) as EdmoreEvent
        if (!event || typeof event.event_id !== 'string' || !event.event_id || ids.has(event.event_id)
          || !Number.isSafeInteger(event.cursor) || event.cursor <= (loaded.at(-1)?.cursor ?? 0)
          || typeof event.type !== 'string' || typeof event.source !== 'string'
          || typeof event.scope !== 'string' || typeof event.timestamp !== 'string'
          || !Number.isFinite(Date.parse(event.timestamp))) throw new Error('Invalid event envelope, duplicate ID or non-increasing cursor')
        ids.add(event.event_id)
        loaded.push(event)
      } catch (error) {
        throw new Error(`EDMore event log ${this.path}, line ${index + 1}: ${error instanceof Error ? error.message : String(error)}. Original log preserved; repair it before restarting.`)
      }
    }
    this.events = loaded
    this.byId = new Map(loaded.map(event => [event.event_id, event]))
    this.nextCursor = (loaded.at(-1)?.cursor ?? 0) + 1
  }
}

export class EdmoreActionRegistry {
  private running = new Map<string, { action: string; sessionId: string | undefined; fingerprint: string | undefined; promise: Promise<unknown> }>()

  constructor(private hub: EdmoreEventHub) {}

  async run<T>(actionId: string, action: string, sessionId: string | undefined, execute: () => Promise<T>, request?: unknown): Promise<{ action_id: string; replayed: boolean; result: T }> {
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(actionId)) throw new Error('action_id must be 8-160 characters using letters, numbers, dot, underscore, colon, or dash')
    await this.hub.ready()
    const fingerprint = requestFingerprint(request)
    for (const type of ['accepted', 'completed', 'failed']) {
      const receipt = this.hub.findLastByCorrelation(actionId, `edmore.custom.action.${type}`)
      if (receipt && (asRecord(receipt.payload).action !== action || receipt.session_id !== sessionId)) {
        throw new Error(`action_id '${actionId}' belongs to a different action or session`)
      }
      if (receipt && asRecord(receipt.payload).request_fingerprint !== fingerprint) throw new Error(`action_id '${actionId}' has a different or unverifiable request payload`)
    }
    const completed = this.hub.findLastByCorrelation(actionId, 'edmore.custom.action.completed')
    if (completed !== undefined) {
      const payload = asRecord(completed.payload)
      if (payload.action !== action) throw new Error(`action_id '${actionId}' was already used for '${String(payload.action)}'`)
      return { action_id: actionId, replayed: true, result: payload.result as T }
    }
    const failed = this.hub.findLastByCorrelation(actionId, 'edmore.custom.action.failed')
    if (failed !== undefined) {
      const payload = asRecord(failed.payload)
      if (payload.action !== action) throw new Error(`action_id '${actionId}' was already used for '${String(payload.action)}'`)
      throw new Error(typeof payload.error === 'string' ? payload.error : `Action '${action}' previously failed`)
    }
    const current = this.running.get(actionId)
    if (current !== undefined) {
      if (current.action !== action || current.sessionId !== sessionId) throw new Error(`action_id '${actionId}' belongs to a different action or session`)
      if (current.fingerprint !== fingerprint) throw new Error(`action_id '${actionId}' has a different request payload`)
      return { action_id: actionId, replayed: true, result: await current.promise as T }
    }
    const accepted = this.hub.findLastByCorrelation(actionId, 'edmore.custom.action.accepted')
    if (accepted !== undefined) {
      throw new Error(`Action '${actionId}' was accepted before the backend restarted, but its outcome is unknown. Inspect workflow state before retrying with a new action_id.`)
    }
    const promise = (async () => {
      await this.hub.append({
        type: 'edmore.custom.action.accepted',
        source: 'edmore-client-api',
        scope: 'workflow',
        ...sessionId === undefined ? {} : { session_id: sessionId },
        correlation_id: actionId,
        payload: { action, request_fingerprint: fingerprint },
      })
      let result: T
      try {
        result = await execute()
      } catch (error) {
        try {
          await this.hub.append({
          type: 'edmore.custom.action.failed',
          source: 'edmore-client-api',
          scope: 'workflow',
          ...sessionId === undefined ? {} : { session_id: sessionId },
          correlation_id: actionId,
          payload: { action, request_fingerprint: fingerprint, error: error instanceof Error ? error.message : String(error) },
          })
        } catch (receiptError) {
          throw new AggregateError([error, receiptError], `Action '${actionId}' raised an execution error, but its failure receipt could not be saved. Outcome requires verification; do not automatically retry.`)
        }
        throw error
      }
      try {
        await this.hub.append({
          type: 'edmore.custom.action.completed',
          source: 'edmore-client-api',
          scope: 'workflow',
          ...sessionId === undefined ? {} : { session_id: sessionId },
          correlation_id: actionId,
          payload: { action, request_fingerprint: fingerprint, result },
        })
      } catch (error) {
        throw new Error(`Action '${actionId}' returned successfully, but its completion receipt could not be saved. Outcome requires verification; do not automatically retry.`, { cause: error })
      }
      return result
    })()
    this.running.set(actionId, { action, sessionId, fingerprint, promise })
    try {
      return { action_id: actionId, replayed: false, result: await promise }
    } finally {
      this.running.delete(actionId)
    }
  }
}
