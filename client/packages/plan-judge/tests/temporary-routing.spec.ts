import { describe, expect, it, vi } from 'vitest'
import { EdmoreWorkflow } from './workflow-fixture.ts'
import { temporaryPlan, editablePlan } from '../src/temporary-plan.ts'
import { parseRoute, routeChoices, routeRules, type RouteInput } from '../src/routing.ts'
import { JevDecisions, defaults } from '../../jev-decisions/src/provider.ts'
import { planApprovalUiSummary } from '../../backend/src/views.ts'

const input: RouteInput = { query: '这个 workflow 做完了吗', skills: [
  { name: 'align', description: 'Align a microscope', has_contract: true },
  { name: 'history', description: 'Read past evidence', has_contract: false },
], rules: routeRules, context: { status: 'none' } }
const bridge = { status: async () => ({ ok: true, agents: ['agent_mcp_test'], agentInfo: {}, message: '' }),
  listTools: async () => ({ tools: [{ name: 'read', inputSchema: { type: 'object', additionalProperties: false,
    required: ['device'], properties: { device: { type: 'string', enum: ['sim'] } } } }] }) }
const draft = { goal: 'Read simulation', summary: 'Inspect only', steps: [{ agent: 'agent_mcp_test', tool_name: 'read',
  goal: 'Read status', arguments: { device: 'sim' }, success_criterion: 'Result explicitly reports ready=true' }] }
const event = { event_id: 'q', session_id: 's', cursor: 0, timestamp: '', type: 'edmore.trigger.requested', source: 'test', scope: 'workflow', payload: { prompt: 'read simulation' } } as any
function fixture() {
  const events: any[] = []
  const runner = { runRoleOnce: vi.fn(async (_session?: string, _role?: string, prompt?: string) => JSON.stringify(prompt?.startsWith('Select relevant tools')
    ? { tools: [{ agent: 'agent_mcp_test', tool_name: 'read' }] }
    : prompt?.startsWith('Select a Workflow') ? { contract_skill: null, supporting_skills: [] } : draft)) }
  const registry = { snapshot: async () => ({ complete: true, skills: [] }), get: async () => undefined }
  const wf = new EdmoreWorkflow({ append: async (e: any) => { events.push(e); return e } }, bridge, '', undefined, 0, registry, runner)
  vi.spyOn(wf as any, 'loadSkillContracts').mockResolvedValue(new Map())
  return { wf, events, runner }
}

it('revises the current version, allows requested deletion, and invalidates the old approval', async () => {
  const { wf, runner, events } = fixture()
  const old = await temporaryPlan({ ...draft, steps: [draft.steps[0], draft.steps[0]] }, { workflow_id: 'old', session_id: 's', prompt: 'read twice' }, bridge)
  old.source_draft = { id: 'first-draft', text: 'Original plan mcp__test__unrelated_old_tool' }
  wf['pending'].set('old', old); wf['pendingBySession'].set('s', 'old')
  runner.runRoleOnce.mockImplementation(async (_s, _r, prompt) => JSON.stringify(prompt?.startsWith('Validate translation fidelity')
    ? { matches: true, differences: [], changes: ['Removed the second read as requested'] }
    : prompt?.startsWith('Select relevant tools') ? { tools: [{ agent: 'agent_mcp_test', tool_name: 'read' }] } : draft))
  const result = await wf['createAndQueuePlan']('Remove the second read', event, old)
  expect(result.action).toBe('planned')
  expect(result.plan?.steps).toHaveLength(1)
  expect(result.plan?.revision?.previous_workflow_id).toBe('old')
  expect(result.plan?.source_draft?.id).toBe('old')
  expect(result.plan?.user_summary).toContain('Step 2 removed')
  expect(runner.runRoleOnce.mock.calls.some(call => call[2]?.startsWith('Validate translation fidelity') || call[1] === 'judge')).toBe(false)
  expect(wf['pending'].has('old')).toBe(false)
  await expect(wf.approve('old', 's')).rejects.toThrow('not found')
  expect(events.some(e => e.type === 'edmore.workflow.started')).toBe(false)
})

it('retains the old plan when revised parameters fail schema validation and blocks approval while revising', async () => {
  const { wf, runner } = fixture()
  const old = await temporaryPlan(draft, { workflow_id: 'old', session_id: 's', prompt: 'read' }, bridge)
  wf['pending'].set('old', old); wf['pendingBySession'].set('s', 'old')
  wf['revisingPlans'].add('old')
  await expect(wf.approve('old', 's')).rejects.toThrow('revision is in progress')
  wf['revisingPlans'].delete('old')
  runner.runRoleOnce.mockImplementation(async (_s, _r, prompt) => JSON.stringify(prompt?.startsWith('Select relevant tools')
    ? { tools: [{ agent: 'agent_mcp_test', tool_name: 'read' }] }
    : { ...draft, steps: [{ ...draft.steps[0], arguments: { device: 'invalid-device' } }] }))
  expect((await wf['createAndQueuePlan']('Change summary only', event, old)).action).toBe('blocked')
  expect(wf['pending'].get('old')).toBe(old)
  expect(wf['pendingBySession'].get('s')).toBe('old')
  expect(wf['revisingPlans'].size).toBe(0)
})

describe('structured routing and uncontracted plans', () => {
  it('validates catalog identity, authority and resume state', () => {
    expect(parseRoute({ action: 'start_workflow', workflow: 'history', selected_skills: [], reason: 'go' }, input)).toBeUndefined()
    expect(parseRoute({ action: 'delegate', workflow: null, selected_skills: ['invented'], reason: 'go' }, input)).toBeUndefined()
    expect(parseRoute({ action: 'resume_workflow', workflow: null, selected_skills: [], reason: 'go' }, input)).toBeUndefined()
  })
  it('Jev sees query, names, descriptions and rules; a catalog choice produces a typed route', async () => {
    const choices = routeChoices(input)
    const fetcher = vi.fn(async (_url: any, init: any) => {
      expect(JSON.parse(init.body).state).toEqual(input)
      return Response.json({ model: 'jev-latest', answers: { decision: { type: 'choice', choice: 'skill_1', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(choices).map(k => [k, k === 'skill_1' ? 1 : 0])) } } })
    })
    expect(await new JevDecisions(async () => 'test', defaults, fetcher).route(input, new AbortController().signal))
      .toMatchObject({ action: 'delegate', selected_skills: ['history'], workflow: null })
  })
  it('low confidence clarifies, while unavailable Jev uses the identical LLM route input', async () => {
    const choices = routeChoices(input)
    const low = new JevDecisions(async () => 'test', defaults, async () => Response.json({ model: 'jev-latest', answers: { decision: {
      type: 'choice', choice: 'delegate', confidence: .2, probabilities: Object.fromEntries(Object.keys(choices).map(k => [k, 1 / Object.keys(choices).length])),
    } } }))
    expect(await low.route(input, new AbortController().signal)).toMatchObject({ action: 'clarify' })
    const { wf, runner } = fixture()
    let received: unknown
    wf.registerDecisionProvider({ route: async value => { received = value; return undefined }, shouldPlan: async () => undefined, assessStep: async () => undefined })
    runner.runRoleOnce.mockResolvedValue(JSON.stringify({ action: 'delegate', selected_skills: [], workflow: null, reason: 'Question only' }))
    expect((await wf['routeQuery']('query', event)).action).toBe('delegate')
    expect(runner.runRoleOnce.mock.calls[0][2]).toContain(JSON.stringify(received))
  })
  it('drafts without a semantic judge and blocks MCP until approval', async () => {
    const { wf, events, runner } = fixture()
    wf.registerDecisionProvider({ route: async () => ({ action: 'propose_plan', selected_skills: [], workflow: null, reason: 'No contract' }),
      shouldPlan: async () => undefined, assessStep: async () => undefined })
    const result = await wf.handleTrigger({ ...event, payload: { ...event.payload, plan_mode: true } })
    expect(result.action).toBe('planned')
    expect(result.plan?.planning_mode).toBe('temporary')
    expect(runner.runRoleOnce.mock.calls.map(c => c[1])).toEqual(['planner', 'planner', 'planner'])
    expect(events.some(e => e.type === 'edmore.plan.judged')).toBe(false)
    expect(planApprovalUiSummary(result.plan as any)).toContain('Plan Judge skipped')
    wf.bindHarnessSession('h', 's')
    await expect(wf.beforeLoopToolCall('h', 'agent_mcp_test', 'read', { device: 'sim' }, 'c')).rejects.toThrow('awaiting explicit')
  })
  it('edits create a new approval identity and exact approved arguments remain enforced', async () => {
    const { wf } = fixture()
    const original = await temporaryPlan(draft, { workflow_id: 'old', session_id: 's', prompt: 'read' }, bridge)
    wf['pending'].set('old', original); wf['pendingBySession'].set('s', 'old')
    await expect(wf.editTemporaryPlan('old', 'other', draft)).rejects.toThrow('not found')
    const edited = await wf.editTemporaryPlan('old', 's', { ...draft, summary: 'Changed' })
    expect(edited.workflow_id).not.toBe('old')
    await expect(wf.approve('old', 's')).rejects.toThrow('not found')
    await expect(wf.approve(edited.workflow_id, 'other')).rejects.toThrow('another session')
    expect((await wf.approve(edited.workflow_id, 's')).action).toBe('execute')
    wf.bindHarnessSession('h', 's')
    await expect(wf.beforeLoopToolCall('h', 'agent_mcp_test', 'read', { device: 'sim', extra: true }, 'c')).rejects.toThrow('ARGUMENT_MISMATCH')
    expect(editablePlan(edited).summary).toBe('Changed')
  })
  it('rejects missing targets, unknown tools, invalid enums, nested approval metadata and empty plans', async () => {
    for (const invalid of [ { ...draft, approved: true }, { ...draft, steps: [] },
      { ...draft, steps: [{ ...draft.steps[0], arguments: {} }] },
      { ...draft, steps: [{ ...draft.steps[0], arguments: { device: 'real' } }] },
      { ...draft, steps: [{ ...draft.steps[0], tool_name: 'invented' }] },
    ]) await expect(temporaryPlan(invalid, { workflow_id: 'w', prompt: 'read' }, bridge)).rejects.toThrow()
  })
})
