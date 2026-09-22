import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { loadSkillDirectory, completionSatisfied } from '../../../skill-format.mjs'
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
