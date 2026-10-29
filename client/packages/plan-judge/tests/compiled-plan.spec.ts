import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { EdmoreWorkflow } from './workflow-fixture.ts'
import { PlanSkillAdapter } from '../src/skills.ts'
import { workflowToolSchemaName } from '../../runtime/src/workflow-mcp.ts'

const skillRoot = resolve(import.meta.dirname, '../../../skills')
it('compiles device selection plus six TEM tools without a model-generated plan and preserves verification', async () => {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  ctx.skills.registerProvider(control => new FileSystemSkillProvider(ctx, control, {
    includeDefaultRoots: false, watch: false, customSkillDirs: [skillRoot],
  }))
  try {
    const evidence = await new PlanSkillAdapter(ctx.skills, {}).prepare('tem-twin-alignment-sequence')
    const children = evidence.workflow_contracts.slice(1)
    const bridge = {
      async status() { return { ok: true, agents: ['agent_mcp_tem_twin'] } },
      async listTools() { return { tools: [...new Set(children.flatMap(child => child.required_tools))]
        .map(tool => ({ name: workflowToolSchemaName('agent_mcp_tem_twin', tool.split('.')[1]), inputSchema: { type: 'object', properties: {} } })) } },
    }
    const workflow = new EdmoreWorkflow({} as never, bridge as never, skillRoot, undefined, 0, ctx.skills)
    const run = vi.fn(async (_session, _role, prompt) => {
      expect(prompt).toContain('Select a Workflow and optional supporting Skills for')
      return '{"contract_skill":"tem-twin-alignment-sequence","supporting_skills":[]}'
    })
    workflow.bindRoleRunner({ runRoleOnce: run })
    const start = performance.now()
    const plan = await workflow['generatePlan']('compiled', 'Run complete TEM Twin alignment', 'session')
    const elapsed = performance.now() - start
    expect(run).toHaveBeenCalledTimes(1)
    expect(plan.steps).toHaveLength(children.reduce((total, child) => total + child.steps!.length, 0))
    expect(plan.steps.map(step => step.skill_step_id)).toEqual(children.flatMap(child => child.steps!.map(step => step.id)))
    expect(plan.skill_evidence?.contract_skill.skill_id).toBe('tem_twin_alignment_sequence')
    for (const step of plan.steps) {
      const template = children.find(child => child.skill_id === step.skill)!.steps!.find(item => item.id === step.skill_step_id)!
      expect(step.on_success).toBe(template.on_success)
      expect(step.on_failure).toBe(template.on_failure)
      expect(step.max_visits).toBe(template.max_visits)
      expect(step.completion).toEqual(template.completion)
      for (const [key, binding] of Object.entries(template.parameters)) expect(step.arguments[key]).toEqual(binding.value)
    }
    expect(plan.steps).toHaveLength(7)
    expect(plan.steps[0].tool_name).toBe('select_device')
    expect(plan.steps[0].required_inputs.join(' ')).toContain('device')
    expect(plan.steps.at(-1)!.on_success).toBe('complete')
    expect((await workflow['judgePlan'](plan)).status).toBe('pass')
    expect(plan.planning_mode).toBe('skill_compiler')
    expect((await workflow['autoRepairAndJudge'](plan)).judge_report.status).toBe('pass')
    expect(run).toHaveBeenCalledTimes(1)
    console.log(`TEM compound: ${plan.steps.length} steps compiled in ${elapsed.toFixed(1)} ms with mocked selection; 0 step-generation model calls.`)
  } finally { await ctx.fiber.dispose() }
})

function parameterFixture() {
  const steps = [{ id: 'measure', title: 'Measure', purpose: 'Measure a result', tool: 'agent_test.measure',
    parameters: { seconds: { mode: 'default', value: 7 }, fixed: { mode: 'fixed', value: 3 }, optional: { mode: 'tool_default' } },
    confirm: false, completion: { type: 'tool_success' }, on_success: 'correct', on_failure: 'pause' },
  { id: 'correct', title: 'Correct', purpose: 'Use measured result', tool: 'agent_test.correct',
    parameters: { value: { mode: 'result', value: '{{measure.value}}' }, permission: { mode: 'ask' } },
    confirm: true, confirmation: 'Confirm correction', completion: { type: 'tool_success' }, on_success: 'complete', on_failure: 'pause' }]
  const row = { name: 'parameter-test', description: 'Parameters', content: 'Parameter instructions', provider: 'fixture', source: 'test',
    invocation: { modelInvocable: true, userInvocable: true }, metadata: { edmore: { authority: 'workflow', workflow: {
      schema_version: 1, id: 'parameter_test', version: '1.0.0', steps,
    } } } }
  const registry = { snapshot: async () => ({ complete: true, skills: [row] }), get: async () => row }
  const bridge = { status: async () => ({ ok: true, agents: ['agent_test'] }), listTools: async () => ({ tools: [
    { name: 'measure', inputSchema: { type: 'object', properties: { seconds: { type: 'number', minimum: 0 }, fixed: { type: 'number' }, optional: { type: 'boolean' } } } },
    { name: 'correct', inputSchema: { type: 'object', properties: { value: { type: 'number' }, permission: { type: 'boolean' } } } },
  ] }) }
  return new EdmoreWorkflow({} as never, bridge as never, '', undefined, 0, registry as never)
}

it('asks the model only for allowed overrides and keeps result bindings, defaults and confirmations', async () => {
  const workflow = parameterFixture()
  let overrides = [{ skill: 'parameter_test', step: 'measure', parameter: 'seconds', value: 12 }]
  const run = vi.fn(async (_session, _role, prompt) => {
    if (prompt.includes('Select a Workflow and optional supporting Skills for')) return '{"contract_skill":"parameter-test"}'
    expect(prompt).toContain('Extract parameter overrides')
    expect(prompt).toContain('Tool parameter schemas')
    return JSON.stringify({ overrides })
  })
  workflow.bindRoleRunner({ runRoleOnce: run })
  const plan = await workflow['generatePlan']('params', 'Wait 12 seconds', 'session')
  expect(run).toHaveBeenCalledTimes(2)
  expect(plan.steps[0].arguments).toEqual({ seconds: 12, fixed: 3 })
  expect(plan.steps[1].arguments).toEqual({ value: '{{measure.value}}' })
  expect(plan.steps[1].required_inputs).toEqual(expect.arrayContaining(['Confirm correction', 'Confirm parameter permission before execution']))
  expect((await workflow['judgePlan'](plan)).status).toBe('pass')
  overrides = []
  expect((await workflow['generatePlan']('defaults', 'Use defaults', 'session')).steps[0].arguments.seconds).toBe(7)
})

it.each(['fixed', 'value', 'permission', 'invented'])('rejects an override of %s instead of regenerating a permissive plan', async parameter => {
  const workflow = parameterFixture()
  workflow.bindRoleRunner({ async runRoleOnce(_session, _role, prompt) {
    if (prompt.includes('Select a Workflow and optional supporting Skills for')) return '{"contract_skill":"parameter-test"}'
    return JSON.stringify({ overrides: [{ skill: 'parameter_test', step: parameter === 'value' || parameter === 'permission' ? 'correct' : 'measure', parameter, value: 1 }] })
  } })
  await expect(workflow['generatePlan']('invalid', 'Override', 'session')).rejects.toThrow('undeclared override')
})

it('keeps schema validation and fails closed on invalid parameter output or provider failure', async () => {
  const workflow = parameterFixture()
  let output = '{"overrides":[{"skill":"parameter_test","step":"measure","parameter":"seconds","value":"wrong type"}]}'
  workflow.bindRoleRunner({ async runRoleOnce(_session, _role, prompt) {
    if (prompt.includes('Select a Workflow and optional supporting Skills for')) return '{"contract_skill":"parameter-test"}'
    if (output === 'fail') throw new Error('provider unavailable')
    return output
  } })
  const plan = await workflow['generatePlan']('invalid-type', 'Wait', 'session')
  expect((await workflow['judgePlan'](plan)).status).not.toBe('pass')
  output = '{"steps":[],"overrides":[]}'
  await expect(workflow['generatePlan']('invalid-shape', 'Wait', 'session')).rejects.toThrow('only an overrides array')
  output = 'fail'
  await expect(workflow['generatePlan']('failure', 'Wait', 'session')).rejects.toThrow('provider unavailable')
})

it('allows explicit tool-default values but rejects duplicate overrides', async () => {
  const workflow = parameterFixture()
  const item = { skill: 'parameter_test', step: 'measure', parameter: 'optional', value: true }
  let overrides = [item]
  workflow.bindRoleRunner({ async runRoleOnce(_session, _role, prompt) {
    return prompt.includes('Select a Workflow and optional supporting Skills for') ? '{"contract_skill":"parameter-test"}' : JSON.stringify({ overrides })
  } })
  expect((await workflow['generatePlan']('optional', 'Enable optional flag')).steps[0].arguments).toEqual({ seconds: 7, fixed: 3, optional: true })
  overrides = [item, item]
  await expect(workflow['generatePlan']('duplicate', 'Enable optional flag')).rejects.toThrow('Duplicate parameter override')
})

it('falls back for legacy, optional-action, recovery and ambiguous step contracts', async () => {
  const workflow = parameterFixture()
  const base = (await workflow['generatePlan']('base', 'parameter-test')).skill_evidence!.contract_skill
  for (const contract of [{ ...base, steps: undefined }, { ...base, optional_tools: ['agent_test.optional'] },
    { ...base, recovery_loops: [{}] }, { ...base, steps: [base.steps![0], base.steps![0]] }]) {
    expect(await workflow['compileStructuredPlan']('legacy', 'Wait', undefined, contract as never, [contract] as never, [contract] as never)).toBeUndefined()
  }
})

it('locally reviews persisted compiled plans and blocks invalid parameters without LLM review or repair', async () => {
  const workflow = parameterFixture()
  const plan = JSON.parse(JSON.stringify(await workflow['generatePlan']('compiled-review', 'parameter-test')))
  const run = vi.fn(async () => { throw new Error('No plan-review model call allowed') })
  workflow.bindRoleRunner({ runRoleOnce: run })
  expect((await workflow['autoRepairAndJudge'](plan)).judge_report.status).toBe('pass')
  plan.steps[0].arguments.fixed = 99
  const rejected = await workflow['autoRepairAndJudge'](plan)
  expect(rejected.judge_report.status).toBe('block')
  expect(rejected.judge_replan_history).toEqual([])
  expect(run).not.toHaveBeenCalled()
})

it('retains LLM plan review for non-compiled plans', async () => {
  const workflow = parameterFixture()
  const plan = await workflow['generatePlan']('legacy-review', 'parameter-test')
  delete plan.planning_mode
  const run = vi.fn(async (_session, role, prompt) => {
    expect(role).toBe('judge')
    expect(prompt).toContain('Review the proposed PlanReview')
    return '{"status":"pass","summary":"Reviewed","issues":[]}'
  })
  workflow.bindRoleRunner({ runRoleOnce: run })
  expect((await workflow['autoRepairAndJudge'](plan)).judge_report.status).toBe('pass')
  expect(run).toHaveBeenCalledOnce()
})

it('still judges compiled-plan execution results through Jev and LLM fallback', async () => {
  const workflow = parameterFixture()
  const plan = await workflow['generatePlan']('result-review', 'parameter-test')
  expect(plan.planning_mode).toBe('skill_compiler')
  const run = vi.fn(async (_session, role, prompt) => {
    expect(role).toBe('judge')
    expect(prompt).toContain('ONE executed workflow step')
    return '{"status":"uncertain","reason":"Measurement is inconclusive"}'
  })
  workflow.bindRoleRunner({ runRoleOnce: run })
  const assess = vi.fn(async () => ({ status: 'failure' as const, reason: 'Measured criterion failed' }))
  const dispose = workflow.registerDecisionProvider({ shouldPlan: async () => undefined, assessStep: assess })
  expect(await workflow['assessStepResult'](plan, plan.steps[0], { value: 2 }, 'session', 'first')).toMatchObject({ status: 'failure' })
  expect(assess).toHaveBeenCalledOnce()
  expect(run).not.toHaveBeenCalled()
  dispose()
  expect(await workflow['assessStepResult'](plan, plan.steps[0], {}, 'session', 'second')).toMatchObject({ status: 'uncertain' })
  expect(run).toHaveBeenCalledOnce()
})
