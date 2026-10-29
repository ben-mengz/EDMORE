import { expect, it, vi } from 'vitest'
import { EdmoreWorkflow } from './workflow-fixture.ts'

function setup() {
  const events: any[] = []
  const workflow = new EdmoreWorkflow({ append: async (e: any) => { events.push(e); return e } },
    { status: async () => ({ ok: true, agents: [], agentInfo: {}, message: '' }), listTools: async () => ({ tools: [] }) }, '')
  const route = vi.spyOn(workflow as any, 'routeQuery').mockRejectedValue(new Error('must not route'))
  const plan = vi.spyOn(workflow as any, 'createAndQueuePlan').mockResolvedValue({ action: 'planned' })
  const event = (prompt: string, plan_mode = false) => ({ event_id: prompt, session_id: 's', payload: { prompt, plan_mode } } as any)
  return { workflow, events, route, plan, event }
}

it('cancels all workflow states when Judge is disabled, without aborting ordinary chat', async () => {
  const f = setup()
  await f.workflow.ready()
  const abort = vi.fn()
  const remove = vi.fn()
  f.workflow.onUnavailable = abort
  f.workflow.onDisabled = remove
  await f.workflow.handleTrigger({ ...f.event('ordinary'), session_id: 'chat' })
  f.workflow.bindHarnessSession('chat-agent', 'chat')
  const plan = (id: string) => ({ workflow_id: id, session_id: id, steps: [] } as any)
  f.workflow['pending'].set('pending', plan('pending'))
  f.workflow['pendingBySession'].set('pending', 'pending')
  f.workflow['activeBySession'].set('active', { plan: plan('active'), nextStepIndex: 0 })
  f.workflow['pausedBySession'].set('paused', { plan: plan('paused'), reason: 'test', state: {} })
  f.workflow['workflowSessions'].add('planning')
  f.workflow.bindHarnessSession('old-agent', 'active')
  f.workflow['inFlightToolCalls'].set('active', { callId: 'c' } as any)
  await f.workflow.disable('Judge unavailable')
  expect(abort.mock.calls.map(([id]) => id).sort()).toEqual(['active', 'paused', 'pending', 'planning'])
  expect(f.workflow['pending'].size).toBe(0)
  expect(f.workflow['activeBySession'].size).toBe(0)
  expect(f.workflow['pausedBySession'].size).toBe(0)
  expect(f.events.find(e => e.type === 'edmore.workflow.cancelled' && e.session_id === 'active').payload.hardware_stop_verified).toBe(false)
  expect(f.events.some(e => e.type === 'edmore.custom.workflow_mode.disabled')).toBe(true)
  await expect(f.workflow.beforeLoopToolCall('old-agent', 'agent_mcp_tem', 'read', {}, 'late')).rejects.toThrow('cancelled')
  expect((await f.workflow.handleTrigger({ ...f.event('new request'), session_id: 'active' })).action).toBe('chat')
  f.workflow.bindHarnessSession('new-agent', 'active')
  await expect(f.workflow.beforeLoopToolCall('new-agent', 'agent_mcp_tem', 'read', {}, 'new')).resolves.toBeUndefined()
  expect((await f.workflow.handleTrigger(f.event('controlled', true))).action).toBe('blocked')
  await expect(f.workflow.requestWorkflowMode('new-agent', 'draft')).rejects.toThrow('unavailable')
  await f.workflow.disable('again')
  expect(remove).toHaveBeenCalledOnce()
})

it('requests mode without planning, and only a scoped explicit user reply enables it', async () => {
  const f = setup()
  await expect(f.workflow.requestWorkflowMode('unknown', 'Read status')).rejects.toThrow('No bound')
  f.workflow.bindHarnessSession('agent', 's')
  expect(await f.workflow.requestWorkflowMode('agent', 'Read status')).toMatchObject({ mode_enabled: false })
  expect(f.events.some(e => e.type === 'edmore.custom.workflow_mode.enabled')).toBe(false)
  await f.workflow.handleTrigger({ ...f.event('enable workflow mode'), session_id: 'other' })
  expect(f.events.find(e => e.type === 'edmore.custom.workflow_mode.enabled' && e.session_id === 'other')?.payload?.draft).toBeUndefined()
  await f.workflow.handleTrigger(f.event('打开 workflow mode'))
  expect(f.events.filter(e => e.type === 'edmore.custom.workflow_mode.enabled' && e.session_id === 's')).toHaveLength(1)
  expect(f.plan).not.toHaveBeenCalled()
  expect(f.workflow['pending'].size).toBe(0)
})

it.each(['取消', '查看wiki', 'expired'])('does not enable stale or unconfirmed requests: %s', async reply => {
  const f = setup()
  f.workflow.bindHarnessSession('agent', 's')
  await f.workflow.requestWorkflowMode('agent', 'Read status')
  if (reply === 'expired') f.workflow['modeRequests'].get('s')!.expires = 0
  await f.workflow.handleTrigger(f.event(reply === 'expired' ? 'enable workflow mode' : reply))
  expect(f.events.some(e => e.type === 'edmore.custom.workflow_mode.enabled')).toBe(false)
  expect(f.workflow['modeRequests'].size).toBe(0)
  expect(f.plan).not.toHaveBeenCalled()
})

it('carries an immutable session-scoped draft identity into mode confirmation', async () => {
  const f = setup()
  f.workflow.bindHarnessSession('agent', 's')
  await f.workflow.requestWorkflowMode('agent', 'Original alignment plan')
  await f.workflow.handleTrigger(f.event('打开 workflow mode'))
  const event = f.events.find(e => e.type === 'edmore.custom.workflow_mode.enabled')
  const draft = f.workflow['resolveSourceDraft']('generate it', { ...f.event('generate it'), payload: { source_draft_id: event.payload.source_draft_id } })
  expect(draft?.text).toBe('Original alignment plan')
  expect(() => f.workflow['resolveSourceDraft']('generate it', { ...f.event('generate it'), session_id: 'other', payload: { source_draft_id: draft!.id } })).toThrow('another conversation')
})

it('resolves a reference to the conversation draft, not a fresh unrelated workflow', () => {
  const f = setup()
  f.workflow['hub'].latestConversationReply = vi.fn(() => ({ event_id: 'draft-event', payload: { text: 'TEM alignment plan mcp__tem_twin__align_beam_and_c2' } } as any))
  expect(f.workflow['resolveSourceDraft']('根据你的计划生成plan', f.event('reference'))).toMatchObject({ id: 'draft-event', text: expect.stringContaining('TEM alignment') })
  expect(() => f.workflow['assertDraftTools']('mcp__tem_twin__align_beam_and_c2', { steps: [{ agent: 'agent_sem', tool_name: 'acquire' }] } as any)).toThrow('differs from the original draft')
})

it('fails closed on missing references and handles mismatch complaints as discussion', async () => {
  const f = setup()
  expect(() => f.workflow['resolveSourceDraft']('根据你的计划', f.event('reference'))).toThrow('Cannot find')
  expect((await f.workflow.handleTrigger(f.event('workflow跟你刚才的计划完全不一样', true))).action).toBe('chat')
  expect(f.plan).not.toHaveBeenCalled()
})

it('pins the named source workflow and blocks a substituted experiment before approval', async () => {
  const f = setup()
  f.plan.mockRestore()
  f.workflow['modeDrafts'].set('s', { id: 'source', text: 'Plan tem-twin-alignment-sequence: mcp__tem_twin__align_beam_and_c2' })
  f.workflow['skillRegistry'] = {} as any
  vi.spyOn(f.workflow as any, 'skillAdapter').mockResolvedValue({ catalog: async () => [{ name: 'tem-twin-alignment-sequence' }, { name: 'ptychography' }] })
  const generate = vi.spyOn(f.workflow as any, 'generatePlan').mockResolvedValue({ steps: [{ agent: 'agent_sem', tool_name: 'acquire' }] })
  const result = await f.workflow.handleTrigger({ ...f.event('use draft', true), payload: { prompt: 'use draft', plan_mode: true, source_draft_id: 'source' } })
  expect(generate.mock.calls[0][5]).toMatchObject({ workflow: 'tem-twin-alignment-sequence' })
  expect(generate.mock.calls[0][1]).toContain('mcp__tem_twin__align_beam_and_c2')
  expect(result.action).toBe('blocked')
  expect(result.message).toContain('differs from the original draft')
  expect(f.events.some(e => e.type === 'edmore.approval.requested')).toBe(false)
})

it.each(['可以查看一下wiki吗', '查看一下过去的workflow', '解释这个skill', 'align my twin', '/planning is a word'])('ordinary message bypasses routing and planning: %s', async prompt => {
  const f = setup()
  expect((await f.workflow.handleTrigger(f.event(prompt))).action).toBe('chat')
  expect(f.route).not.toHaveBeenCalled()
  expect(f.plan).not.toHaveBeenCalled()
})

it('entering plan mode alone never generates a plan', async () => {
  const f = setup()
  await f.workflow.handleTrigger(f.event('\\plan'))
  expect(f.events.some(e => e.payload?.text?.includes('Plan mode enabled'))).toBe(true)
  expect(f.route).not.toHaveBeenCalled()
  expect(f.plan).not.toHaveBeenCalled()
})

it.each(['\\plan test task', '/plan test task'])('only the explicit command plans: %s', async prompt => {
  const f = setup()
  expect((await f.workflow.handleTrigger(f.event(prompt))).action).toBe('planned')
  expect(f.plan.mock.calls[0][0]).toBe('test task')
  expect(f.route).not.toHaveBeenCalled()
})

it('accepts the explicit composer mode flag and preserves pending state for ordinary questions', async () => {
  const f = setup()
  expect((await f.workflow.handleTrigger(f.event('test task', true))).action).toBe('planned')
  f.workflow['pendingBySession'].set('s', 'pending')
  f.workflow['pending'].set('pending', { workflow_id: 'pending', session_id: 's' } as any)
  expect((await f.workflow.handleTrigger(f.event('查看一下过去的workflow'))).action).toBe('chat')
  expect(f.workflow['pending'].has('pending')).toBe(true)
})

it('uses Skills and their tools normally without creating or requesting a workflow', async () => {
  const f = setup()
  f.workflow.bindHarnessSession('agent', 's')
  const contracts = vi.spyOn(f.workflow as any, 'loadSkillContracts').mockResolvedValue(new Map([
    ['alignment', { required_tools: ['agent_mcp_tem_twin.align_beam_and_c2'] }],
  ]))
  const result = await f.workflow.handleTrigger(f.event('align my selected twin'))
  expect(result.action).toBe('chat')
  expect(result.executionPrompt).toContain('Use relevant Skills normally')
  expect(result.executionPrompt).toContain('Reply in English')
  await expect(f.workflow.beforeLoopToolCall('agent', 'agent_mcp_tem_twin', 'align_beam_and_c2', { device: 'edmore/tem/twin' }, 'call')).resolves.toBeUndefined()
  expect(contracts).not.toHaveBeenCalled()
  expect(await f.workflow.requestWorkflowMode('agent', 'Alignment draft')).toMatchObject({ status: 'ordinary_skill_mode', plan_submitted: false })
  expect(f.workflow['modeRequests'].size).toBe(0)
  expect(f.events.some(e => e.type === 'edmore.approval.requested' || e.type === 'edmore.custom.workflow_mode.enabled')).toBe(false)
  expect(f.plan).not.toHaveBeenCalled()
})

it('does not transfer ordinary tool permission across sessions or into plan mode', async () => {
  const f = setup()
  f.workflow.bindHarnessSession('agent', 's')
  f.workflow.bindHarnessSession('other-agent', 'other')
  vi.spyOn(f.workflow as any, 'loadSkillContracts').mockResolvedValue(new Map([
    ['alignment', { required_tools: ['agent_mcp_tem_twin.align_beam_and_c2'] }],
  ]))
  await f.workflow.handleTrigger(f.event('align my twin'))
  await expect(f.workflow.beforeLoopToolCall('other-agent', 'agent_mcp_tem_twin', 'align_beam_and_c2', {}, 'other')).rejects.toThrow('approve its PlanReview')
  await f.workflow.handleTrigger(f.event('\\plan'))
  await expect(f.workflow.beforeLoopToolCall('agent', 'agent_mcp_tem_twin', 'align_beam_and_c2', {}, 'after-mode-switch')).rejects.toThrow('approve its PlanReview')
})

it('keeps pending, paused and cancelled gates even after ordinary Skill use', async () => {
  const f = setup()
  f.workflow.bindHarnessSession('agent', 's')
  vi.spyOn(f.workflow as any, 'loadSkillContracts').mockResolvedValue(new Map([
    ['alignment', { required_tools: ['agent_mcp_tem_twin.align_beam_and_c2'] }],
  ]))
  await f.workflow.handleTrigger(f.event('align my twin'))
  f.workflow['pendingBySession'].set('s', 'pending')
  f.workflow['pending'].set('pending', { workflow_id: 'pending', session_id: 's' } as any)
  await expect(f.workflow.beforeLoopToolCall('agent', 'agent_mcp_tem_twin', 'align_beam_and_c2', {}, 'pending')).rejects.toThrow('approve its PlanReview')
  f.workflow['pausedBySession'].set('s', {} as any)
  await expect(f.workflow.beforeLoopToolCall('agent', 'agent_mcp_tem_twin', 'align_beam_and_c2', {}, 'paused')).rejects.toThrow('paused')
  f.workflow['cancelledSessions'].add('s')
  await expect(f.workflow.beforeLoopToolCall('agent', 'agent_mcp_tem_twin', 'align_beam_and_c2', {}, 'cancelled')).rejects.toThrow('cancelled')
})

it('explicitly enables Workflow mode once without asking again or approving a plan', async () => {
  const f = setup()
  await f.workflow.handleTrigger(f.event('enable workflow mode'))
  expect(f.events.filter(e => e.type === 'edmore.custom.workflow_mode.enabled')).toHaveLength(1)
  expect(f.events.some(e => e.type === 'edmore.approval.requested')).toBe(false)
  expect(f.plan).not.toHaveBeenCalled()
  const messages = f.events.flatMap(e => typeof e.payload?.text === 'string' ? [e.payload.text] : [])
  expect(messages.join('\n')).toContain('No plan has been approved or executed')
  expect(messages.join('\n')).not.toMatch(/[\u4e00-\u9fff]/)
})
