import { describe, expect, it } from 'vitest'
import { projectUiEvents } from '../../backend/src/views.ts'
import type { EdmoreEvent } from '../../contracts/src/index.ts'

describe('decision progress UI', () => {
  it('distinguishes workflow intent routing from plan judging', () => {
    const [event] = projectUiEvents({ event_id: 'intent', cursor: 1, timestamp: '', source: 'edmore-workflow-intent',
      type: 'edmore.assistant.started', scope: 'workflow', session_id: 's',
      payload: { hidden: true, role: 'orchestrator@isolated' } } as EdmoreEvent)
    expect(event!.payload.label).toBe('Checking workflow intent')
  })
  it('shows Jev activity and the fallback reason in the same conversation', () => {
    const event: EdmoreEvent = { event_id: 'decision', cursor: 1, timestamp: '', source: 'edmore-plan-judge',
      type: 'edmore.custom.decision.status', scope: 'workflow', session_id: 's', workflow_id: 'w',
      payload: { provider: 'Jev', phase: 'started' } }
    const [started] = projectUiEvents(event)
    expect(started!.payload.label).toBe('Jev is deciding')
    expect(started!.session_id).toBe('s')
    expect(started!.workflow_id).toBe('w')
    const [fallback] = projectUiEvents({ ...event, payload: { provider: 'Jev', phase: 'fallback', reason: 'timeout-2500ms' } })
    expect(fallback!.payload.label).toBe('Jev unavailable; falling back to LLM')
    expect(fallback!.payload.detail).toBe('timeout-2500ms')
    const [llm] = projectUiEvents({ ...event, type: 'edmore.assistant.started', source: 'edmore-result-judge',
      payload: { hidden: true, role: 'judge@isolated', model: 'gpt-5-mini' } })
    expect(llm!.payload.label).toBe('LLM is judging result (gpt-5-mini)')
  })
})
