import { describe, it, expect } from 'vitest'
import { EdmoreWorkflow, type SkillContract } from './workflow-fixture.ts'
import { confirmationObservation, type ConfirmationContract } from '../src/confirmation.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spec: ConfirmationContract = { id: 'settings', title: 'Accept Settings', before_tool: 'agent_sem.finish',
  source_tools: ['agent_sem.prepare', 'agent_sem.update'], result_field: 'settings', fields: ['dose'],
  edit_tool: 'agent_sem.update', names_argument: 'names', values_argument: 'values' }
const contract: SkillContract = { skill_id: 'example', name: 'Example', agents: ['agent_sem'],
  required_tools: ['agent_sem.prepare', 'agent_sem.finish'], ordered_tools: ['agent_sem.prepare', 'agent_sem.finish'],
  optional_tools: ['agent_sem.update'], references: [], instructions: 'Confirm current Settings before finishing. Verify actual edits.', confirmation_steps: [spec] }
const result = (dose: number) => ({ structuredContent: { ok: true, settings: { dose } }, content: [] })

async function fixture(statePath?: string) {
  const events: any[] = []
  const workflow = new EdmoreWorkflow({ append: async (event: any) => { events.push(event); return event } } as never, {
    status: async () => ({ ok: true, agents: ['agent_sem'], agentInfo: {}, message: '' }),
    listTools: async () => ({ tools: ['prepare', 'update', 'finish'].map(name => ({ name })) }),
  }, '', statePath)
  await workflow.ready()
  let decision: any = { intent: 'accept' }
  workflow.bindRoleRunner({ async runRoleOnce(_session, _role, prompt) {
    return JSON.stringify(prompt.includes('Interpret the latest response') ? decision : { status: 'success', reason: 'Verified tool result.' })
  } })
  const plan = workflow['normalizePlannerPlan']('w', 'Example', 's', contract, [contract], [contract], JSON.stringify({ steps: [
    { skill: 'example', agent: 'agent_sem', tool_name: 'prepare' }, { skill: 'example', agent: 'agent_sem', tool_name: 'finish' },
  ] }))
  workflow['pending'].set('w', plan)
  plan.judge_report = { status: 'pass', grounding_status: 'fully_grounded', summary: 'Fixture reviewed', issues: [] }
  workflow.bindHarnessSession('h', 's')
  await workflow.approve('w', 's')
  await workflow.beforeLoopToolCall('h', 'agent_sem', 'prepare', {}, 'c1')
  await workflow.afterLoopToolResult('h', 'agent_sem', 'prepare', 'c1', result(5))
  return { workflow, plan, events, decide: (value: any) => { decision = value } }
}

describe('independent confirmations', () => {
  it('inserts a pinned gate, displays observed values, and accepts without a tool call', async () => {
    const { workflow, plan, events } = await fixture()
    expect(plan.steps.map(step => step.kind ?? 'tool')).toEqual(['tool', 'confirmation', 'tool'])
    expect((await workflow['judgePlan'](plan)).status).toBe('pass')
    const paused = workflow['pausedBySession'].get('s')!
    expect(paused.reason).toContain('"dose": 5')
    await expect(workflow.beforeLoopToolCall('h', 'agent_sem', 'update', {}, 'bad')).rejects.toThrow('paused')
    const route = await workflow.resume('w', 's', 'confirm')
    expect(route.action).toBe('execute')
    expect(workflow.nextLoopDispatch('s')?.step.tool_name).toBe('finish')
    expect(events.some(event => event.type === 'edmore.confirmation.accepted')).toBe(true)
  })

  it('rejects stale and cross-step button confirmations', async () => {
    const { workflow } = await fixture()
    expect((await workflow.resume('w', 's', 'confirm', undefined, { version: 'old' })).action).toBe('blocked')
    expect((await workflow.resume('w', 's', 'confirm', undefined, { step_id: '999' })).action).toBe('blocked')
    expect(workflow.nextLoopDispatch('s')).toBeUndefined()
  })

  it('reviews edits before executing, verifies the update, and requires a new confirmation', async () => {
    const { workflow, decide, plan } = await fixture()
    const oldVersion = plan.confirmation_observations!['example:settings']!.version
    decide({ intent: 'edit', edits: { dose: 8 } })
    expect((await workflow.resume('w', 's', 'dose=8')).action).toBe('blocked')
    expect(workflow.nextLoopDispatch('s')).toBeUndefined()
    decide({ intent: 'accept' })
    await workflow.resume('w', 's', 'confirm')
    expect(workflow.nextLoopDispatch('s')?.step.arguments).toEqual({ names: ['dose'], values: [8] })
    await workflow.beforeLoopToolCall('h', 'agent_sem', 'update', { names: ['dose'], values: [8] }, 'c2')
    await workflow.afterLoopToolResult('h', 'agent_sem', 'update', 'c2', result(8))
    expect(workflow.nextLoopDispatch('s')).toBeUndefined()
    expect(plan.confirmation_observations!['example:settings']!.version).not.toBe(oldVersion)
    expect((await workflow.resume('w', 's', 'confirm', undefined, { version: oldVersion })).action).toBe('blocked')
    await workflow.resume('w', 's', 'confirm')
    expect(workflow.nextLoopDispatch('s')?.step.tool_name).toBe('finish')
  })

  it('does not accept missing or mismatched write evidence, even if LLM says success', async () => {
    const { workflow, decide, plan } = await fixture()
    decide({ intent: 'edit', edits: { dose: 8 } })
    await workflow.resume('w', 's', 'dose=8')
    decide({ intent: 'accept' })
    await workflow.resume('w', 's', 'confirm')
    await workflow.beforeLoopToolCall('h', 'agent_sem', 'update', { names: ['dose'], values: [8] }, 'c2')
    await workflow.afterLoopToolResult('h', 'agent_sem', 'update', 'c2', result(5))
    expect(plan.confirmation_observations!['example:settings']).toBeUndefined()
    expect((await workflow.resume('w', 's', 'confirm')).action).toBe('blocked')
    expect(workflow.nextLoopDispatch('s')).toBeUndefined()
  })

  it('does not silently upgrade legacy approved plans or accept incomplete snapshots', async () => {
    expect(confirmationObservation(spec, { content: [{ text: 'None of the parameters found' }] }, 'x')).toBeUndefined()
    const { workflow, plan } = await fixture()
    const changed = { ...plan, steps: plan.steps.filter(step => step.kind !== 'confirmation') }
    expect((await workflow['judgePlan'](changed)).status).not.toBe('pass')
    const legacyContract = { ...contract, confirmation_steps: undefined }
    const legacy = workflow['normalizePlannerPlan']('old', 'Old plan', 's', legacyContract, [legacyContract], [legacyContract], JSON.stringify({ steps: [
      { skill: 'example', agent: 'agent_sem', tool_name: 'prepare' }, { skill: 'example', agent: 'agent_sem', tool_name: 'finish' },
    ] }))
    expect(legacy.steps).toHaveLength(2)
  })

  it('restores a pending confirmation and its displayed version after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'confirmation-restart-'))
    try {
      const path = join(directory, 'state.json')
      const { plan } = await fixture(path)
      const restored = new EdmoreWorkflow({ append: async (event: any) => event } as never, {
        status: async () => ({ ok: true, agents: ['agent_sem'], agentInfo: {}, message: '' }), listTools: async () => ({ tools: [] }),
      }, '', path)
      await restored.ready()
      restored.bindRoleRunner({ async runRoleOnce() { return '{"intent":"accept"}' } })
      expect(restored.nextLoopDispatch('s')).toBeUndefined()
      const version = plan.confirmation_observations!['example:settings']!.version
      expect((await restored.resume('w', 's', 'confirm', undefined, { workflow_id: 'w', step_id: '2', version })).action).toBe('execute')
      expect(restored.nextLoopDispatch('s')?.step.tool_name).toBe('finish')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
