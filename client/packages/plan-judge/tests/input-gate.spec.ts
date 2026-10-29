import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EdmoreWorkflow } from './workflow-fixture.ts'

const contract: any = { skill_id: 'device', name: 'Device', agents: ['agent_mcp_tem_twin'],
  required_tools: ['agent_mcp_tem_twin.select_device'], ordered_tools: ['agent_mcp_tem_twin.select_device'], optional_tools: [], references: [],
  steps: [{ id: 'select', title: 'Choose device', tool: 'agent_mcp_tem_twin.select_device',
    parameters: { device: { mode: 'ask' } }, confirm: true, confirmation: 'Which device?',
    completion: { type: 'field_equals', field: 'available', value: true }, on_success: 'complete', on_failure: 'pause' }] }

const reply = (prompt: string, event_id = 'answer') => ({ session_id: 's', event_id, payload: { prompt, plan_mode: true },
  type: 'edmore.trigger.requested', source: 'edmore-client-api', scope: 'workflow', cursor: 0, timestamp: new Date().toISOString() })

async function fixture(path?: string) {
  const events: any[] = []
  const workflow = new EdmoreWorkflow({ append: async (event: any) => { events.push(event); return event } } as never,
    { status: async () => ({ ok: true, agents: ['agent_mcp_tem_twin'], agentInfo: {}, message: '' }), listTools: async () => ({ tools: [] }) }, '', path)
  await workflow.ready()
  workflow.bindHarnessSession('h', 's')
  workflow.bindRoleRunner({ runRoleOnce: async () => '{"intent":"resume","reason":"User supplied the requested device"}' })
  const plan = workflow['normalizePlannerPlan']('w', 'select device', 's', contract, [contract], [contract], JSON.stringify({ steps: [
    { skill: 'device', agent: 'agent_mcp_tem_twin', tool_name: 'select_device', arguments: {} },
  ] }))
  plan.judge_report = { status: 'pass', grounding_status: 'fully_grounded', summary: 'Reviewed', issues: [] }
  return { workflow, plan, events }
}

it('pauses before first execution and accepts a device reply once, without another confirm', async () => {
  const { workflow, plan, events } = await fixture()
  workflow['pending'].set('w', plan)
  const approved = await workflow.approve('w', 's')
  expect(approved.action).toBe('blocked')
  expect(workflow.nextLoopDispatch('s')).toBeUndefined()
  const route = await workflow.handleTrigger(reply('edmore/tem/twin'))
  expect(route.action).toBe('execute')
  const dispatch = workflow.nextLoopDispatch('s')!
  expect(dispatch.prompt).toContain('"gate_confirmed": true')
  expect(dispatch.retryPrompt).toContain('edmore/tem/twin')
  expect(dispatch.retryPrompt).not.toContain('Full approved plan')
  await expect(workflow.beforeLoopToolCall('h', 'agent_mcp_tem_twin', 'select_device', { device: 'edmore/tem/twin' }, 'call')).resolves.toBe(true)
  expect(events.filter(e => e.type === 'edmore.workflow.paused')).toHaveLength(1)
  expect(await workflow.pauseEmptyOutput('s', dispatch, 'late', 'Empty')).toBe(false)
})

it('retains the confirmed device across an empty-output pause, restart, and retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'edmore-input-gate-'))
  try {
    const path = join(root, 'state.json')
    const { workflow, plan } = await fixture(path)
    workflow['pending'].set('w', plan)
    await workflow.approve('w', 's')
    await workflow.handleTrigger(reply('edmore/tem/twin'))
    const dispatch = workflow.nextLoopDispatch('s')!
    expect(await workflow.pauseEmptyOutput('s', dispatch, 'run', 'Empty after retry')).toBe(true)
    expect(workflow.nextLoopDispatch('s')).toBeUndefined()
    const restored = (await fixture(path)).workflow
    await restored.handleTrigger(reply('retry', 'retry'))
    expect(restored.nextLoopDispatch('s')?.retryPrompt).toContain('edmore/tem/twin')
    expect(restored.nextLoopDispatch('s')?.retryPrompt).toContain('"gate_confirmed": true')
    await expect(restored.beforeLoopToolCall('h', 'agent_mcp_tem_twin', 'select_device', { device: 'edmore/tem/twin' }, 'call')).resolves.toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects stale empty-output pauses after cancellation or a new resume', async () => {
  const { workflow, plan } = await fixture()
  workflow['pending'].set('w', plan)
  await workflow.approve('w', 's')
  await workflow.handleTrigger(reply('edmore/tem/twin'))
  const dispatch = workflow.nextLoopDispatch('s')!
  expect(await workflow.pauseEmptyOutput('s', { ...dispatch, executionId: 'stale' }, 'late', 'Empty')).toBe(false)
  await workflow.cancelSession('s')
  expect(await workflow.pauseEmptyOutput('s', dispatch, 'late', 'Empty')).toBe(false)
  expect(workflow['pausedBySession'].has('s')).toBe(false)
})
