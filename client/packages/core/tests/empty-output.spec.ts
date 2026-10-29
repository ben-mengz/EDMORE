import { describe, expect, it, vi } from 'vitest'
import { EdmoreAgentLoopBridge, summarizeAssistantOutput } from '../../runtime/src/services.ts'
import { emptyOutputAction } from '../../runtime/src/workflow-dispatch.ts'
import { projectUiEvents } from '../../backend/src/views.ts'
import { TaskQueues } from '../src/tasks.ts'

const dispatch = { workflowId: 'w', executionId: 'generation-1', role: 'executor:agent_mcp_tem_twin',
  prompt: 'Full approved context', retryPrompt: 'Compact context: gate_confirmed=true; device=edmore/tem/twin',
  retryToolName: 'mcp__tem_twin__select_device',
  step: { step_id: '1', agent: 'agent_mcp_tem_twin', tool_name: 'select_device' } }
const event = { event_id: 'request', session_id: 's', payload: {} } as any
type Attempt = { text?: string; calls?: number; finish?: string; wait?: () => Promise<void>; error?: string }

function fixture(attempts: Attempt[]) {
  const events: any[] = [], prompts: any[] = [], agents: any[] = []
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const tasks = new TaskQueues()
  const ctx = { edmoreTasks: tasks, sessions: { flush: async () => true }, get: () => undefined,
    logger: { warn: vi.fn() }, on: (name: string, fn: (...args: any[]) => void) => {
      const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(fn)
      return () => set.delete(fn)
    } }
  const scheduling = { next: vi.fn(() => dispatch), pauseEmptyOutput: vi.fn(async () => true) }
  const hub = { append: vi.fn(async (e: any) => { events.push(e); return e }) }
  const bridge = new EdmoreAgentLoopBridge(ctx as never, hub as never,
    { configFor: async () => ({ provider: 'test', model: 'test', maxTokens: 2048, timeoutMs: 1000 }) } as never, scheduling as never)
  const ensure = vi.spyOn(bridge as any, 'ensureAgent').mockImplementation(async (_session, role, options) => {
    const attempt = attempts[agents.length]
    if (!attempt) throw new Error('Unexpected extra attempt')
    const sessionEvents: any[] = []
    const agent = { id: `h-${agents.length}`, session: { seq: 0, snapshotEvents: () => sessionEvents },
      cancel: vi.fn(), followup: (message: any) => prompts.push({ role, options, message }), whenIdle: async () => {
        await attempt.wait?.()
        if (attempt.error) throw new Error(attempt.error)
        for (const listener of listeners.get('agent/assistant-stream') ?? []) listener({ agent,
          frame: { type: 'chunk', chunk: { type: 'finish', reason: { kind: attempt.finish ?? 'stop' } } } })
        for (let i = 0; i < (attempt.calls ?? 0); i++) sessionEvents.push({ seq: sessionEvents.length, type: 'tool/call', data: {} })
        sessionEvents.push({ seq: sessionEvents.length, type: 'assistant/message', data: {
          message: { content: [{ type: 'text', text: attempt.text ?? '' }] }, usage: { outputTokens: 2048, reasoningTokens: 2048 },
        } })
      } }
    agents.push(agent)
    return { handle: { agent, dispose: vi.fn() }, selection: {} }
  })
  return { bridge, events, prompts, agents, ensure, scheduling, tasks, hub }
}

describe('empty executor output', () => {
  it('retries once in a fresh executor with compact context and pauses visibly on a second empty response', async () => {
    const f = fixture([{ finish: 'max-tokens' }, {}])
    await f.bridge.runWorkflow(event, dispatch.prompt, 'w', dispatch.role)
    expect(f.ensure).toHaveBeenCalledTimes(2)
    expect(f.prompts[1].message.content[0].text).toBe(dispatch.retryPrompt)
    expect(f.prompts[1].options).toMatchObject({ emptyOutputRetried: true, maxTokensOverride: 4096,
      retryToolName: dispatch.retryToolName })
    expect(f.prompts[0].role).not.toBe(f.prompts[1].role)
    expect(f.scheduling.pauseEmptyOutput).toHaveBeenCalledOnce()
    expect(f.events.find(e => e.payload?.finish_reason === 'max-tokens')?.payload.usage.reasoningTokens).toBe(2048)
    expect(f.events.some(e => e.payload?.text?.includes('Retrying this step once'))).toBe(true)
  })

  it('does not increase the output budget based only on token count', async () => {
    const f = fixture([{}, { text: 'A useful response' }])
    await f.bridge.runWorkflow(event, dispatch.prompt, 'w', dispatch.role)
    expect(f.prompts[1].options.maxTokensOverride).toBeUndefined()
    expect(f.scheduling.pauseEmptyOutput).not.toHaveBeenCalled()
  })

  it('never replays an attempt that made any tool call, including a result that is unknown', async () => {
    const f = fixture([{ calls: 1 }])
    await f.bridge.runWorkflow(event, dispatch.prompt, 'w', dispatch.role)
    expect(f.ensure).toHaveBeenCalledOnce()
    expect(f.scheduling.pauseEmptyOutput).not.toHaveBeenCalled()
  })

  it('does not retry provider errors as empty output', async () => {
    const f = fixture([{ error: 'transport failed' }])
    await expect(f.bridge.runWorkflow(event, dispatch.prompt, 'w', dispatch.role)).rejects.toThrow('transport failed')
    expect(f.ensure).toHaveBeenCalledOnce()
  })

  it('stops retrying once the retry calls a tool and the workflow completes', async () => {
    const f = fixture([{}, { calls: 1, wait: async () => { f.scheduling.next.mockReturnValue(undefined as any) } }])
    await f.bridge.runWorkflow(event, dispatch.prompt, 'w', dispatch.role)
    expect(f.ensure).toHaveBeenCalledTimes(2)
    expect(f.scheduling.pauseEmptyOutput).not.toHaveBeenCalled()
  })

  it('does not launch the retry when Cancel arrives at the retry notice', async () => {
    const f = fixture([{}])
    f.hub.append.mockImplementation(async (e: any) => {
      f.events.push(e)
      if (e.payload?.text?.includes('Retrying this step once')) f.tasks.cancel('s')
      return e
    })
    await expect(f.bridge.runWorkflow(event, dispatch.prompt, 'w', dispatch.role)).rejects.toThrow('cancelled')
    expect(f.ensure).toHaveBeenCalledOnce()
    expect(f.scheduling.pauseEmptyOutput).not.toHaveBeenCalled()
  })

  it('suppresses late text from the previous execution after a new resume has been scheduled', async () => {
    let finish!: () => void
    const f = fixture([{ text: 'Please confirm again', wait: () => new Promise<void>(resolve => { finish = resolve }) }, { text: 'Resumed' }])
    const first = f.bridge.runWorkflow(event, dispatch.prompt, 'w', dispatch.role)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const second = f.bridge.runWorkflow({ ...event, event_id: 'resume' }, dispatch.prompt, 'w', dispatch.role)
    finish()
    await Promise.all([first, second])
    const late = f.events.find(e => e.payload?.text === 'Please confirm again')
    expect(late.payload).toMatchObject({ hidden: true, superseded: true })
    expect(projectUiEvents(late)).toEqual([])
  })

  it('lets Cancel win while an unresponsive model is still running', async () => {
    let finish!: () => void
    const f = fixture([{ wait: () => new Promise<void>(resolve => { finish = resolve }) }])
    const run = f.bridge.runWorkflow(event, dispatch.prompt, 'w', dispatch.role)
    const rejection = expect(run).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    f.tasks.cancel('s')
    await rejection
    finish()
    await vi.waitFor(() => expect(f.events.some(e => e.type === 'edmore.assistant.failed')).toBe(true))
    expect(f.ensure).toHaveBeenCalledOnce()
    expect(f.scheduling.pauseEmptyOutput).not.toHaveBeenCalled()
  })

  it('does not mistake reasoning-only output for visible text and counts only the current attempt tool calls', () => {
    const result = summarizeAssistantOutput({ snapshotEvents: () => [
      { seq: 1, type: 'tool/call', data: {} },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'thinking' }] } } },
    ] } as never, 2)
    expect(result).toMatchObject({ text: '', toolCalls: 0 })
  })

  it('never retries a cancelled, superseded, paused, or advanced workflow', () => {
    const input = { role: dispatch.role, previous: dispatch, next: dispatch, text: '', toolCalls: 0,
      retried: false, cancelled: false, superseded: false }
    expect(emptyOutputAction(input)).toBe('retry')
    for (const override of [{ cancelled: true }, { superseded: true }, { next: undefined },
      { next: { ...dispatch, executionId: 'new-generation' } }, { next: { ...dispatch, step: { ...dispatch.step, step_id: '2' } } }]) {
      expect(emptyOutputAction({ ...input, ...override })).toBeUndefined()
    }
  })
})
