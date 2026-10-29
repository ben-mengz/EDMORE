import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EdmoreWorkflow, type SkillContract } from './workflow-fixture.ts'
import { recoveryOutcome, validateRecoveryLoops, type RecoveryLoop } from '../src/recovery.ts'

const loop: RecoveryLoop = { id: 'fix-loop', tool: 'agent_sem.check', fix_tool: 'agent_sem.fix', choice_argument: 'fix_name',
  success_field: 'evaluation.passed', failures_field: 'evaluation.failed_checks', details_field: 'evaluation.checks', options: [
    { id: 'fix_a', when: ['a'], description: 'Change A; recheck B.' }, { id: 'fix_b', when: ['b'], description: 'Change B; recheck A.' },
  ] }
const contract: SkillContract = { skill_id: 'example', name: 'Example', agents: ['agent_sem'], required_tools: ['agent_sem.check', 'agent_sem.finish'],
  ordered_tools: ['agent_sem.check', 'agent_sem.finish'], optional_tools: ['agent_sem.fix'], references: [],
  instructions: 'Check all diagnostics. Ask for a fix choice, apply it and check again.', recovery_loops: [loop] }
const bridge = { status: async () => ({ ok: true, agents: ['agent_sem'], agentInfo: {}, message: '' }),
  listTools: async () => ({ tools: ['check', 'finish', 'fix'].map(name => ({ name, inputSchema: name === 'fix' ? {
    type: 'object', required: ['fix_name'], properties: { fix_name: { type: 'string', enum: ['fix_a', 'fix_b'] } },
  } : {} })) }) }
const diagnostic = (failed: string[]) => ({ content: [], structuredContent: { ok: true, evaluation: {
  passed: failed.length === 0, failed_checks: failed, checks: Object.fromEntries(failed.map(id => [id, { actual: 10, limit: 5, passed: false }])),
} } })
async function fixture(path?: string) {
  const events: any[] = []
  const workflow = new EdmoreWorkflow({ append: async (event: any) => { events.push(event); return event } } as never, bridge, '', path)
  await workflow.ready()
  workflow.bindHarnessSession('h', 's')
  workflow.bindRoleRunner({ async runRoleOnce() { return '{"status":"success","reason":"Tool executed."}' } })
  const plan = workflow['normalizePlannerPlan']('w', 'test', 's', contract, [contract], [contract], JSON.stringify({ steps: [
    { skill: 'example', agent: 'agent_sem', tool_name: 'check' }, { skill: 'example', agent: 'agent_sem', tool_name: 'finish' },
  ] }))
  plan.judge_report = { status: 'pass', grounding_status: 'fully_grounded', summary: 'Fixture reviewed', issues: [] }
  if (!workflow['pausedBySession'].has('s')) { workflow['pending'].set('w', plan); await workflow.approve('w', 's') }
  return { workflow, events, plan }
}
async function call(workflow: EdmoreWorkflow, tool: string, id: string, result: any, args = {}) {
  await workflow.beforeLoopToolCall('h', 'agent_sem', tool, args, id)
  await workflow.afterLoopToolResult('h', 'agent_sem', tool, id, result)
}

describe('declared recovery loops', () => {
  it('repairs nested argument spelling without executing or consuming workflow visits', async () => {
    const { workflow, plan, events } = await fixture()
    plan.steps[0]!.arguments = { arguments: [{ __type__: 'RunApertureCenteringSettings', maximum_iterations: 8 }] }
    const active = workflow['activeBySession'].get('s')!
    const visits = structuredClone(active.stepVisits)
    const start = workflow.nextLoopDispatch('s')!
    await expect(workflow.beforeLoopToolCall('h', 'agent_sem', 'check', {
      arguments: [{ __type: 'RunApertureCenteringSettings', maximum_iterations: 8 }],
    }, 'typo')).rejects.toThrow('arguments[0].__type__')
    const retry = workflow.nextLoopDispatch('s')!
    expect(retry.step.step_id).toBe(start.step.step_id)
    expect(retry.argumentRepairAttempt).toBe(1)
    expect(retry.prompt).toContain('"executed":false')
    expect(retry.prompt).toContain('"issue":"unexpected"')
    expect(active.stepVisits).toEqual(visits)
    expect(active.nextStepIndex).toBe(0)
    expect(workflow['inFlightToolCalls'].size).toBe(0)
    expect(events.some(e => e.type === 'edmore.workflow.paused')).toBe(false)
    await workflow.beforeLoopToolCall('h', 'agent_sem', 'check', {
      arguments: [{ maximum_iterations: 8, __type__: 'RunApertureCenteringSettings' }],
    }, 'corrected')
    expect(active.argumentRepair).toBeUndefined()
    expect(workflow['inFlightToolCalls'].get('s')?.callId).toBe('corrected')
  })

  it('allows two corrections, then pauses without entering the failure branch', async () => {
    const { workflow, plan } = await fixture()
    plan.steps[0]!.arguments = { fixed: 8 }
    for (let i = 1; i <= 3; i++) {
      await expect(workflow.beforeLoopToolCall('h', 'agent_sem', 'check', { fixed: '8' }, `bad-${i}`)).rejects.toThrow('ARGUMENT_MISMATCH')
      expect(workflow['activeBySession'].get('s')!.nextStepIndex).toBe(0)
      expect(workflow['inFlightToolCalls'].size).toBe(0)
      if (i < 3) expect(workflow.nextLoopDispatch('s')?.argumentRepairAttempt).toBe(i)
    }
    expect(workflow.nextLoopDispatch('s')).toBeUndefined()
    expect(workflow['pausedBySession'].get('s')!.state.executed).toBe(false)
    await expect(workflow.beforeLoopToolCall('h', 'agent_sem', 'check', { fixed: 8 }, 'late')).rejects.toThrow('paused')
  })

  it('preserves dynamic inputs while rejecting changes to fixed array order and types', async () => {
    const { workflow, plan } = await fixture()
    plan.steps[0]!.arguments = { dynamic: null, fixed: [1, 2] }
    await expect(workflow.beforeLoopToolCall('h', 'agent_sem', 'check', { dynamic: 7, fixed: [2, 1] }, 'order')).rejects.toThrow('fixed[0]')
    await expect(workflow.beforeLoopToolCall('h', 'agent_sem', 'check', { dynamic: 7, fixed: [1, '2'] }, 'type')).rejects.toThrow('fixed[1]')
    await expect(workflow.beforeLoopToolCall('h', 'agent_sem', 'check', { dynamic: 7, fixed: [1, 2] }, 'valid')).resolves.toBe(true)
  })

  it('persists the correction budget across backend restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'argument-repair-'))
    try {
      const path = join(directory, 'state.json')
      const first = await fixture(path)
      first.plan.steps[0]!.arguments = { fixed: 8 }
      await expect(first.workflow.beforeLoopToolCall('h', 'agent_sem', 'check', { fixed: 9 }, 'bad')).rejects.toThrow('ARGUMENT_MISMATCH')
      const second = new EdmoreWorkflow({ append: async (event: any) => event } as never, bridge, '', path)
      await second.ready()
      expect(second.nextLoopDispatch('s')?.argumentRepairAttempt).toBe(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps LLM uncertainty blocked even when structured diagnostics pass', async () => {
    const { workflow } = await fixture()
    workflow.bindRoleRunner({ async runRoleOnce() { return '{"status":"uncertain","reason":"Evidence is incomplete."}' } })
    await call(workflow, 'check', 'uncertain', diagnostic([]))
    expect(workflow.nextLoopDispatch('s')).toBeUndefined()
    expect((workflow['pausedBySession'].get('s')!.state.recovery_choice as any).options).toEqual([])
  })
  it('reviews recovery choices with the plan and rejects speculative fixes or incompatible schemas', async () => {
    const { workflow, plan } = await fixture()
    expect(plan.user_summary).toContain('fix_a (Change A; recheck B.)')
    expect((await workflow['judgePlan'](plan)).issues.some(issue => issue.message.includes('Recovery branch'))).toBe(false)
    expect(() => workflow['normalizePlannerPlan']('other', 'test', 's', contract, [contract], [contract], JSON.stringify({ steps: [
      { skill: 'example', agent: 'agent_sem', tool_name: 'fix', arguments: { fix_name: 'fix_a' } },
    ] }))).toThrow('runtime branch')
    const invalid = new EdmoreWorkflow({ append: async (event: unknown) => event } as never, { ...bridge,
      listTools: async () => ({ tools: [{ name: 'fix', inputSchema: { properties: { fix_name: { type: 'string', enum: ['not_declared'] } } } }] }),
    }, '')
    expect((await invalid['judgePlan'](plan)).issues.some(issue => issue.message.includes('Recovery branch'))).toBe(true)
  })
  it('pauses on diagnostic failure despite ok=true and LLM success, then fixes and rechecks without advancing', async () => {
    const { workflow, events } = await fixture()
    await call(workflow, 'check', 'check-1', diagnostic(['a']))
    expect(workflow.nextLoopDispatch('s')).toBeUndefined()
    expect(workflow['pausedBySession'].get('s')!.reason).toContain('fix_a')
    expect(workflow['pausedBySession'].get('s')!.reason).not.toContain('fix_b:')
    for (const text of ['confirm', 'approve', 'stop', 'fix_b', 'fix_a,fix_b']) expect((await workflow.resume('w', 's', text)).action).toBe('blocked')
    await workflow.resume('w', 's', 'fix_a')
    expect(workflow.nextLoopDispatch('s')?.step.tool_name).toBe('fix')
    await expect(workflow.beforeLoopToolCall('h', 'agent_sem', 'fix', { fix_name: 'fix_b' }, 'bad')).rejects.toThrow('changed argument')
    await call(workflow, 'fix', 'fix-1', { content: [], structuredContent: { ok: true } }, { fix_name: 'fix_a' })
    expect(workflow.nextLoopDispatch('s')?.step.tool_name).toBe('check')
    await call(workflow, 'check', 'check-2', diagnostic(['b']))
    expect((await workflow.resume('w', 's', 'fix_a')).action).toBe('blocked')
    await workflow.resume('w', 's', 'fix_b')
    await call(workflow, 'fix', 'fix-2', { content: [], structuredContent: { ok: true } }, { fix_name: 'fix_b' })
    await call(workflow, 'check', 'check-3', diagnostic([]))
    expect(workflow.nextLoopDispatch('s')?.step.tool_name).toBe('finish')
    expect(events.some(event => event.type === 'edmore.custom.subplan.proposed')).toBe(false)
    expect(events.some(event => event.type === 'edmore.workflow.completed')).toBe(false)
  })

  it('rejects stale choices and remains paused if a fix fails', async () => {
    const { workflow } = await fixture()
    await call(workflow, 'check', 'one', diagnostic(['a']))
    expect((await workflow.resume('w', 's', 'fix_a', undefined, { version: 'old' })).action).toBe('blocked')
    await workflow.resume('w', 's', 'fix_a')
    await call(workflow, 'fix', 'two', { content: [], structuredContent: { ok: false, error: 'not applied' } }, { fix_name: 'fix_a' })
    expect(workflow.nextLoopDispatch('s')).toBeUndefined()
    expect((await workflow.resume('w', 's', 'fix_a')).action).toBe('blocked')
    await workflow.resume('w', 's', 'retry_check')
    expect(workflow.nextLoopDispatch('s')?.step.tool_name).toBe('check')
  })

  it('does not offer fabricated fixes for missing diagnostics, inputs or no solution', () => {
    for (const result of [{}, diagnostic(['defocus_no_maximum']), diagnostic(['missing_input']), diagnostic(['a', 'tool_error'])]) {
      const outcome = recoveryOutcome(loop, result)
      expect(outcome.passed).toBe(false)
      expect(outcome.options).toEqual([])
    }
    expect(() => validateRecoveryLoops([{ ...loop, fix_tool: 'agent_sem.unknown' }], contract.required_tools)).toThrow()
  })

  it('restores pending choices and never automatically replays an in-flight fix after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fix-loop-'))
    try {
      const path = join(directory, 'state.json')
      const first = await fixture(path)
      await call(first.workflow, 'check', 'c1', diagnostic(['a']))
      const second = await fixture(path)
      expect(second.workflow.nextLoopDispatch('s')).toBeUndefined()
      await second.workflow.resume('w', 's', 'fix_a')
      await second.workflow.beforeLoopToolCall('h', 'agent_sem', 'fix', { fix_name: 'fix_a' }, 'in-flight')
      const third = await fixture(path)
      expect(third.workflow.nextLoopDispatch('s')).toBeUndefined()
      expect((await third.workflow.resume('w', 's', 'fix_a')).action).toBe('blocked')
      await third.workflow.resume('w', 's', 'retry_check')
      expect(third.workflow.nextLoopDispatch('s')?.step.tool_name).toBe('check')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
