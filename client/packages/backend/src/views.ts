import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { EdmoreEvent, EventFilter } from '@deepseek-ai/dsh-edmore-contracts'
import { CapabilityUnavailableError } from '@deepseek-ai/dsh-edmore-contracts'
import type { EdmoreEventHub } from '@deepseek-ai/dsh-edmore-core/events'
import { asRecord, textOf } from '@deepseek-ai/dsh-edmore-runtime/services'
export interface EdmoreUiEvent {
  event_id: string
  cursor: number
  timestamp: string
  source: string
  type: string
  scope: 'ui'
  session_id?: string
  workflow_id?: string
  raw_event_id: string
  raw_cursor: number
  payload: Record<string, unknown>
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text) as Record<string, unknown>
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof CapabilityUnavailableError) {
    sendJson(res, 503, { ok: false, error: error.message, code: error.code, capability: error.capability })
    return
  }
  sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://x').searchParams
}

export function eventQuery(req: IncomingMessage): EventFilter {
  const query = queryOf(req)
  const filter: EventFilter = {}
  if (query.has('after')) filter.after = Number(query.get('after'))
  if (query.has('scope')) filter.scope = query.get('scope') ?? ''
  if (query.has('session_id')) filter.session_id = query.get('session_id') ?? ''
  if (query.has('workflow_id')) filter.workflow_id = query.get('workflow_id') ?? ''
  if (query.has('server_id')) filter.server_id = query.get('server_id') ?? ''
  if (query.has('limit')) filter.limit = Number(query.get('limit'))
  return filter
}

export function planApprovalUiSummary(plan: Record<string, unknown>): string {
  const judge = asRecord(plan.judge_report)
  const issues = Array.isArray(judge.issues) ? judge.issues.length : 0
  const steps = Array.isArray(plan.steps) ? plan.steps.length : 0
  return [
    textOf(plan.user_summary) || textOf(plan.summary) || 'I prepared a plan.',
    '',
    plan.planning_mode === 'temporary' ? 'No Contract. Plan Judge skipped; user review required.'
      : `Plan judge: ${textOf(judge.status) || 'pass'}${issues ? ` with ${issues} note${issues === 1 ? '' : 's'}` : ''}.`,
    `${steps} step${steps === 1 ? '' : 's'} are waiting for your approval.`,
  ].join('\n')
}

export function uiProcessLabelForAssistant(event: EdmoreEvent, fallback: string): string {
  const payload = asRecord(event.payload)
  const role = textOf(payload.role)
  const source = event.source
  if (source === 'edmore-workflow-intent') return 'Checking workflow intent'
  if (source === 'edmore-result-judge') return `LLM is judging result${payload.model ? ` (${textOf(payload.model)})` : ''}`
  if (role === 'planner' || source.includes('planner')) return 'Planning'
  if (role === 'judge' || source.includes('judge')) return 'Judging plan'
  if (role === 'orchestrator' || source.includes('orchestrator')) return 'Routing'
  return fallback
}

export function uiEventId(raw: EdmoreEvent, suffix: string): string {
  return `${raw.event_id}:${suffix}`
}

export function toUiEvent(raw: EdmoreEvent, type: string, payload: Record<string, unknown>, suffix = type): EdmoreUiEvent {
  return {
    event_id: uiEventId(raw, suffix),
    cursor: raw.cursor,
    timestamp: raw.timestamp,
    source: raw.source,
    type,
    scope: 'ui',
    ...raw.session_id === undefined ? {} : { session_id: raw.session_id },
    ...raw.workflow_id === undefined ? {} : { workflow_id: raw.workflow_id },
    raw_event_id: raw.event_id,
    raw_cursor: raw.cursor,
    payload,
  }
}

export function projectUiEvents(raw: EdmoreEvent): EdmoreUiEvent[] {
  if (raw.type === 'edmore.custom.decision.status') {
    const status = asRecord(raw.payload)
    const provider = textOf(status.provider)
    const label = status.phase === 'started' ? `${provider} is deciding`
      : status.phase === 'fallback' ? `${provider} unavailable; falling back to LLM`
        : `${provider} decision received`
    return [toUiEvent(raw, 'edmore.ui.process.updated', { label, detail: textOf(status.reason) }, 'decision-process')]
  }
  const payload = asRecord(raw.payload)
  if (payload.superseded === true && raw.type.startsWith('edmore.assistant.')) return []
  if (raw.type === 'edmore.assistant.delta') return []
  if (payload.hidden === true && raw.type.startsWith('edmore.assistant.')) {
    if (raw.type === 'edmore.assistant.started') {
      return [toUiEvent(raw, 'edmore.ui.process.started', { label: uiProcessLabelForAssistant(raw, 'Thinking') })]
    }
    if (raw.type === 'edmore.assistant.completed') {
      return [toUiEvent(raw, 'edmore.ui.process.completed', { label: uiProcessLabelForAssistant(raw, 'Done') })]
    }
    return []
  }

  if (raw.type === 'edmore.trigger.requested') {
    return [
      toUiEvent(raw, 'edmore.ui.conversation.user_message', {
        text: textOf(payload.display_text) || textOf(payload.prompt),
        origin: textOf(payload.origin) || raw.source,
      }),
      toUiEvent(raw, 'edmore.ui.process.started', { label: 'Thinking' }, 'thinking'),
    ]
  }
  if (raw.type === 'edmore.assistant.started') {
    return [toUiEvent(raw, 'edmore.ui.process.started', { label: uiProcessLabelForAssistant(raw, 'Thinking') })]
  }
  if (raw.type === 'edmore.assistant.completed') {
    const text = textOf(payload.text)
    if (text.startsWith('Plan review required before execution.')) return []
    return [
      toUiEvent(raw, 'edmore.ui.conversation.assistant_message', {
        text,
        response_id: textOf(payload.response_id),
        role: textOf(payload.role) || 'assistant',
      }),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Done' }, 'done'),
    ]
  }
  if (raw.type === 'edmore.conversation.updated') {
    return [toUiEvent(raw, 'edmore.ui.conversation.updated', payload)]
  }
  if (raw.type === 'edmore.assistant.failed') {
    return [
      toUiEvent(raw, 'edmore.ui.conversation.assistant_message', {
        text: `Assistant failed: ${textOf(payload.error) || JSON.stringify(payload)}`,
        response_id: textOf(payload.response_id),
        error: true,
      }),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Failed', status: 'failed' }, 'failed'),
    ]
  }
  if (raw.type === 'edmore.plan.generated') {
    return [toUiEvent(raw, 'edmore.ui.process.started', { label: 'Plan generated' })]
  }
  if (raw.type === 'edmore.custom.workflow_mode.disabled') {
    return [toUiEvent(raw, 'edmore.ui.workflow.mode_disabled', payload)]
  }
  if (raw.type === 'edmore.custom.workflow_mode.enabled') {
    return [toUiEvent(raw, 'edmore.ui.workflow.mode_enabled', payload)]
  }
  if (raw.type === 'edmore.custom.planning_proposal.requested') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.planning_proposal', payload),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Planning direction waiting for approval' }, 'planning-proposal-process'),
    ]
  }
  if (raw.type === 'edmore.custom.planning_proposal.accepted') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.planning_proposal_cleared', {}),
      toUiEvent(raw, 'edmore.ui.process.started', { label: 'Creating formal plan' }, 'planning-proposal-process'),
    ]
  }
  if (raw.type === 'edmore.custom.planning_proposal.rejected') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.planning_proposal_cleared', {}),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Planning direction rejected' }, 'planning-proposal-process'),
    ]
  }
  if (raw.type === 'edmore.plan.judged') {
    return [toUiEvent(raw, 'edmore.ui.process.updated', { label: `Plan judge: ${textOf(payload.status) || 'pass'}` })]
  }
  if (raw.type === 'edmore.plan.replan_requested') {
    const attempt = typeof payload.attempt === 'number' ? ` ${payload.attempt}/${payload.max_attempts ?? '?'}` : ''
    return [
      toUiEvent(raw, 'edmore.ui.workflow.replan_requested', { workflow_id: raw.workflow_id, ...payload }),
      toUiEvent(raw, 'edmore.ui.process.updated', { label: `Replanning${attempt}`, detail: textOf(payload.summary) }, 'replan-process'),
    ]
  }
  if (raw.type === 'edmore.custom.plan.repair_exhausted') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.plan_blocked', payload),
      toUiEvent(raw, 'edmore.ui.process.completed', {
        label: 'Plan blocked after judge review',
        detail: textOf(asRecord(payload.plan).judge_report),
        status: 'failed',
      }, 'replan-process'),
    ]
  }
  if (raw.type === 'edmore.approval.requested') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.pending_plan', { plan: payload }),
      toUiEvent(raw, 'edmore.ui.conversation.assistant_message', {
        text: planApprovalUiSummary(payload),
        response_id: raw.event_id,
      }, 'summary'),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Plan waiting for approval' }, 'approval-process'),
    ]
  }
  if (raw.type === 'edmore.approval.granted') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.pending_plan_cleared', {}),
      toUiEvent(raw, 'edmore.ui.process.started', { label: 'Plan approved' }, 'approved-process'),
    ]
  }
  if (raw.type === 'edmore.approval.rejected') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.pending_plan_cleared', {}),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Plan rejected' }, 'rejected-process'),
    ]
  }
  if (raw.type === 'edmore.workflow.started') {
    return [toUiEvent(raw, 'edmore.ui.workflow.started', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.started', { label: 'Workflow started' }, 'process')]
  }
  if (raw.type === 'edmore.workflow.paused') {
    return [toUiEvent(raw, 'edmore.ui.workflow.paused', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.started', { label: 'Workflow paused' }, 'process')]
  }
  if (raw.type === 'edmore.custom.subplan.proposed') {
    return [toUiEvent(raw, 'edmore.ui.workflow.subplan_proposal', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Subplan proposal waiting for approval' }, 'subplan-process')]
  }
  if (raw.type === 'edmore.custom.subplan.accepted') {
    return [toUiEvent(raw, 'edmore.ui.workflow.subplan_accepted', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.started', { label: 'Creating child plan' }, 'subplan-process')]
  }
  if (raw.type === 'edmore.workflow.resumed') {
    return [toUiEvent(raw, 'edmore.ui.workflow.resumed', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.started', { label: 'Workflow resumed' }, 'process')]
  }
  if (raw.type === 'edmore.workflow.cancelled') {
    return [toUiEvent(raw, 'edmore.ui.workflow.cancelled', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Workflow cancelled' }, 'process')]
  }
  if (raw.type === 'edmore.workflow.completed') {
    return [toUiEvent(raw, 'edmore.ui.workflow.completed', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Workflow completed' }, 'process')]
  }
  if (raw.type === 'edmore.workflow.failed') {
    return [toUiEvent(raw, 'edmore.ui.workflow.failed', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Workflow failed', status: 'failed' }, 'process')]
  }
  if (raw.type === 'edmore.custom.harness_tool_call') {
    return [toUiEvent(raw, 'edmore.ui.tool.call', { name: payload.name, arguments: payload.arguments, step: payload.step, turn: payload.turn })]
  }
  if (raw.type === 'edmore.custom.harness_tool_result') {
    return [toUiEvent(raw, 'edmore.ui.tool.result', { call_id: payload.call_id, is_error: payload.is_error, text: payload.text })]
  }
  if (raw.type === 'edmore.hardware.observed') {
    return [toUiEvent(raw, 'edmore.ui.hardware.observed', payload)]
  }
  if (raw.type === 'edmore.confirmation.accepted') return [toUiEvent(raw, 'edmore.ui.confirmation.accepted', payload)]
  if (raw.type === 'edmore.custom.harness_tools_synced') {
    return [toUiEvent(raw, 'edmore.ui.status.updated', { area: 'tools' })]
  }
  if (raw.type === 'edmore.llm.provider.updated' || raw.type === 'edmore.llm.provider.selected') {
    return [toUiEvent(raw, 'edmore.ui.status.updated', { area: 'llm' })]
  }
  if (raw.type === 'edmore.server.started' || raw.type === 'edmore.server.stopped') {
    return [toUiEvent(raw, 'edmore.ui.status.updated', { area: 'runtime', status: raw.type })]
  }
  return []
}

export function uiEventMatches(event: EdmoreUiEvent, filter: EventFilter): boolean {
  return (filter.after === undefined || event.cursor > filter.after)
    && (filter.session_id === undefined || event.session_id === undefined || event.session_id === filter.session_id)
    && (filter.workflow_id === undefined || event.workflow_id === filter.workflow_id)
    && (filter.server_id === undefined)
}

export function queryUiEvents(hub: EdmoreEventHub, filter: EventFilter): EdmoreUiEvent[] {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
  const rawFilter: EventFilter = { ...filter, limit: 1000 }
  delete rawFilter.scope
  const rawEvents = hub.query(rawFilter)
  const projected = rawEvents.flatMap(projectUiEvents).filter(event => uiEventMatches(event, filter))
  return filter.after === undefined ? projected.slice(-limit) : projected.slice(0, limit)
}
