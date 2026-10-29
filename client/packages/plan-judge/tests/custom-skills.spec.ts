import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { EdmoreWorkflow, requiredInputsForStep } from '../src/index.ts'

it('uses saved custom steps, fixed parameters and gates without LLM rewriting or tool execution', async () => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-custom-plan-'))
  vi.stubEnv('DSH_HOME', home)
  try {
    const root = resolve(import.meta.dirname, '../../..')
    const manifest = { id: 'custom_unique_test', name: 'Unique test', description: 'Test', editor_version: 1, agents: ['agent_sem'], ordered_tools: ['agent_sem.wait', 'agent_sem.acquire_4d_stem'], required_tools: ['agent_sem.wait', 'agent_sem.acquire_4d_stem'], steps: [
      { tool: 'agent_sem.wait', parameters: { seconds: { mode: 'fixed', value: 7 } }, confirm: true, confirmation: 'Confirm readiness', expected_output: 'Wait complete', on_success: 'next', on_failure: 'pause' },
      { tool: 'agent_sem.acquire_4d_stem', parameters: { dwell_time: { mode: 'ask' } }, confirm: false, confirmation: '', expected_output: 'Dataset', on_success: 'next', on_failure: 'pause' },
    ] }
    const directory = join(home, 'edmore/skills/custom_unique_test')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    const workflow = new EdmoreWorkflow({} as never, {} as never, join(root, 'skills')) as any
    workflow.roleRunner = { runRoleOnce() { throw new Error('Custom template must not be rewritten') } }
    const plan = await workflow.generatePlan('test', 'custom_unique_test')
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0].arguments.seconds).toBe(7)
    expect(plan.steps[0].required_inputs).toContain('Confirm readiness')
    expect(plan.steps[1].required_inputs.join(' ')).toContain('dwell_time')
    expect(plan.steps[1].required_inputs.join(' ')).toContain('ROI')
    expect(plan.steps[1].on_failure).toBe('pause')
    expect(plan.steps[1].on_success).toBe('complete')
    expect(plan.steps[1].arguments).not.toHaveProperty('dwell_time')
  } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) }
})

it('does not let custom skills disable the server-submission approval gate', () => {
  expect(requiredInputsForStep('custom_test', 'agent_ptychography', 'start_server_ptychography')).toContain('confirm_saved_ptychography_parameters_before_server')
})
