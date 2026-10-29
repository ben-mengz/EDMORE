import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { loadSkillDirectory, completionSatisfied, validateWorkflow } from '../../../skill-format.mjs'
import { EdmoreWorkflow } from './workflow-fixture.ts'

const client = resolve(import.meta.dirname, '../../..')
it('prefers the structured workflow and refuses corrupt YAML instead of falling back', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'edmore-format-'))
  try {
    await cp(join(client, 'skills/acquire-4d-stem'), temp, { recursive: true })
    const skill = await loadSkillDirectory(temp)
    expect(skill.format).toBe('agent-skills-v1')
    expect(skill.steps[1].parameters.seconds.value).toBe(10)
    expect(skill.steps[3].confirmation_required).toBe(true)
    await writeFile(join(temp, 'references/workflow.yaml'), 'schema_version: [broken')
    await expect(loadSkillDirectory(temp)).rejects.toThrow()
    await rm(join(temp, 'references/workflow.yaml'))
    await expect(loadSkillDirectory(temp)).rejects.toThrow('missing')
  } finally { await rm(temp, { recursive: true, force: true }) }
})

it('does not advance the executor when a declared completion condition fails', async () => {
  const workflow = new EdmoreWorkflow({ append: async (event: unknown) => event } as never, {} as never, join(client, 'skills')) as any
  workflow.ensureHydrated = async () => {}
  workflow.saveState = async () => {}
  workflow.bindHarnessSession('test-harness', 'test-session')
  const active = { nextStepIndex: 0, plan: { workflow_id: 'test-workflow', steps: [{ step_id: '1', agent: 'agent_sem', tool_name: 'wait', completion: { type: 'field_equals', field: 'done', value: true } }] } }
  workflow.activeBySession.set('test-session', active)
  workflow.handleRuntimeBlocker = vi.fn(async () => {})
  await workflow.afterLoopToolResult('test-harness', 'agent_sem', 'wait', 'test-call', { content: [], structuredContent: { done: false } })
  expect(workflow.handleRuntimeBlocker).toHaveBeenCalledOnce()
  expect(active.nextStepIndex).toBe(0)
})

it('loads a plain standard skill without requiring a manifest', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'edmore-knowledge-'))
  try {
    await writeFile(join(temp, 'SKILL.md'), '---\nname: analysis-notes\ndescription: Notes for analysis\n---\nRead these notes.')
    expect((await loadSkillDirectory(temp)).kind).toBe('knowledge')
  } finally { await rm(temp, { recursive: true, force: true }) }
})

it('checks structured results conservatively', () => {
  expect(completionSatisfied({ type: 'field_present', field: 'data.path' }, { structuredContent: { data: { path: '/test' } } })).toBe(true)
  expect(completionSatisfied({ type: 'field_equals', field: 'done', value: true }, { structuredContent: { done: false } })).toBe(false)
  expect(completionSatisfied({ type: 'field_present', field: 'path' }, { content: [{ text: 'success' }] })).toBe(false)
  expect(completionSatisfied({ type: 'semantic_judge', criteria: 'The beam is centered.' }, {})).toBe(true)
})

it('requires an explicit semantic judge criterion', () => {
  const workflow = { schema_version: 1, id: 'semantic_test', version: '1', steps: [{
    id: 'measure', title: 'Measure', purpose: 'Measure alignment', tool: 'agent_sem.wait', parameters: {}, confirm: false,
    confirmation: '', expected_output: 'Alignment measurement', completion: { type: 'semantic_judge', criteria: '' }, on_success: 'complete', on_failure: 'pause',
  }] }
  expect(() => validateWorkflow(workflow)).toThrow('Missing semantic judge criteria')
  workflow.steps[0].completion.criteria = 'Beam-centre distance is at most 0.02 field half-widths.'
  expect(validateWorkflow(workflow).steps[0].completion.criteria).toContain('0.02')
})

it('validates named transitions and requires a bound for loops', () => {
  const step = (id: string, on_success: string, on_failure: string, max_visits?: number) => ({
    id, title: id, purpose: id, tool: 'agent_sem.wait', parameters: {}, confirm: false,
    confirmation: '', expected_output: 'ok', completion: { type: 'tool_success' },
    on_success, on_failure, ...(max_visits === undefined ? {} : { max_visits }),
  })
  const loop = { schema_version: 1, id: 'loop_test', version: '1.0.0', steps: [
    step('measure', 'complete', 'adjust'), step('adjust', 'measure', 'pause'),
  ] }
  expect(() => validateWorkflow(loop)).toThrow('requires max_visits')
  loop.steps[1].max_visits = 3
  expect(validateWorkflow(loop).steps[1].on_success).toBe('measure')
  loop.steps[0].on_failure = 'missing'
  expect(() => validateWorkflow(loop)).toThrow('Unsupported failure transition')
})

it('requires every workflow to declare an explicit success transition', () => {
  const workflow = { schema_version: 1, id: 'missing_success', version: '1.0.0', steps: [{
    id: 'measure', title: 'Measure', purpose: 'Measure once', tool: 'agent_sem.wait', parameters: {}, confirm: false,
    confirmation: '', expected_output: 'ok', completion: { type: 'tool_success' }, on_success: 'next', on_failure: 'pause',
  }] }
  expect(() => validateWorkflow(workflow)).toThrow('at least one on_success: complete')
})

it('follows a declared failure transition instead of pausing', async () => {
  const events: any[] = []
  const workflow = new EdmoreWorkflow({ append: async (event: any) => { events.push(event); return event } } as never, {} as never, join(client, 'skills')) as any
  workflow.ensureHydrated = async () => {}
  workflow.saveState = async () => {}
  workflow.bindHarnessSession('test-harness', 'test-session')
  const base = { agent: 'agent_sem', tool_name: 'wait', skill: 'loop_test', goal: 'measure', arguments: {}, required_inputs: [], expected_output: 'ok' }
  const active = { nextStepIndex: 0, stepVisits: {}, plan: { workflow_id: 'test-workflow', steps: [
    { ...base, step_id: '1', skill_step_id: 'measure', completion: { type: 'field_equals', field: 'converged', value: true }, on_success: 'complete', on_failure: 'adjust' },
    { ...base, step_id: '2', skill_step_id: 'adjust', completion: { type: 'tool_success' }, on_success: 'measure', on_failure: 'pause', max_visits: 3 },
  ] } }
  workflow.activeBySession.set('test-session', active)
  workflow.handleRuntimeBlocker = vi.fn(async () => {})
  await workflow.afterLoopToolResult('test-harness', 'agent_sem', 'wait', 'test-call', { content: [], structuredContent: { converged: false } })
  expect(active.nextStepIndex).toBe(1)
  expect(workflow.handleRuntimeBlocker).not.toHaveBeenCalled()
  expect(events.some(event => event.type === 'edmore.workflow.transitioned' && event.payload.outcome === 'failure')).toBe(true)
})

it('only completes a workflow through the explicit complete transition', async () => {
  const events: any[] = []
  const workflow = new EdmoreWorkflow({ append: async (event: any) => { events.push(event); return event } } as never, {} as never, join(client, 'skills')) as any
  workflow.saveState = async () => {}
  const step = { step_id: '1', agent: 'agent_sem', tool_name: 'wait', on_success: 'complete' }
  const active = { nextStepIndex: 0, plan: { workflow_id: 'test-workflow', steps: [step] } }
  workflow.activeBySession.set('session', active)

  expect(await workflow.followStepTransition(active, step, 'done', 'success', 'session', 'done-call')).toBe(false)
  expect(await workflow.followStepTransition(active, step, 'next', 'success', 'session', 'next-call')).toBe(false)
  expect(events.some(event => event.type === 'edmore.workflow.completed')).toBe(false)

  expect(await workflow.followStepTransition(active, step, 'complete', 'success', 'session', 'complete-call')).toBe(true)
  expect(events.filter(event => event.type === 'edmore.workflow.completed')).toHaveLength(1)
})

it('pauses before exceeding a loop step max_visits bound', async () => {
  const workflow = new EdmoreWorkflow({ append: async (event: unknown) => event } as never, {} as never, join(client, 'skills')) as any
  workflow.saveState = async () => {}
  const target = { step_id: '1', skill_step_id: 'measure', agent: 'agent_sem', tool_name: 'wait', skill: 'loop_test', goal: 'measure', arguments: {}, required_inputs: [], expected_output: 'ok', on_success: 'complete', on_failure: 'pause' }
  const source = { ...target, step_id: '2', skill_step_id: 'adjust', on_success: 'measure', max_visits: 2 }
  const active = { nextStepIndex: 1, stepVisits: { adjust: 2 }, plan: { workflow_id: 'test-workflow', steps: [target, source] } }
  workflow.activeBySession.set('session', active)
  workflow.handleRuntimeBlocker = vi.fn(async () => {})
  expect(await workflow.followStepTransition(active, source, 'measure', 'success', 'session', 'call')).toBe(true)
  expect(workflow.handleRuntimeBlocker).toHaveBeenCalledWith(active, target, 0, 'session', 'call', expect.stringContaining('2/2'))
})

it('pins the acquisition definition and judges fixed values and gates from that snapshot', async () => {
  const bridge = { async status() { return { ok: true, agents: ['agent_sem'] } }, async listTools() { return { tools: ['play_bf', 'wait', 'sync_pixel_size', 'stop_playing_detector', 'acquire_4d_stem'].map(name => ({ name, inputSchema: { type: 'object', properties: name === 'wait' ? { seconds: { type: 'integer' } } : {} } })) } } }
  const workflow = new EdmoreWorkflow({} as never, bridge as never, join(client, 'skills')) as any
  const plan = await workflow.generatePlan('test', 'acquire_4d_stem')
  expect(plan.steps).toHaveLength(7)
  expect(plan.steps[1].arguments.seconds).toBe(10)
  expect(plan.steps[5].arguments.seconds).toBe(10)
  expect(plan.steps[3].required_inputs).toContain('confirm_roi_selection_after_pixel_sync')
  expect(plan.steps[0].skill_snapshot.digest).toHaveLength(64)
  workflow.loadSkillContracts = () => { throw new Error('Must use pinned definitions') }
  expect((await workflow.judgePlan(plan)).status).toBe('pass')
  plan.steps[1].arguments.seconds = 3
  plan.steps[3].required_inputs = []
  const report = await workflow.judgePlan(plan)
  expect(report.status).not.toBe('pass')
  expect(report.issues.some(item => item.message.includes('Fixed skill parameter'))).toBe(true)
  expect(report.issues.some(item => item.message.includes('confirmation'))).toBe(true)
})
