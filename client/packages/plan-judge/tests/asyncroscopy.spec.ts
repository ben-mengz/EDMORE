import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { loadSkillDirectory, completionSatisfied } from '../../../skill-format.mjs'
import { workflowMcpView } from '../../runtime/src/workflow-mcp.ts'
import { allowedToolNamesForRole } from '../../runtime/src/services.ts'
import { nionSwiftHarnessToolName } from '../src/index.ts'
import { EdmoreWorkflow } from './workflow-fixture.ts'

it('binds the HAADF demo to standard MCP names and keeps executor namespaces isolated', async () => {
  const skill = await loadSkillDirectory(resolve(import.meta.dirname, '../../../skills/asyncroscopy-haadf-demo'))
  expect(skill.steps).toHaveLength(4)
  expect(skill.steps.every(s => !s.confirm && s.tool.startsWith('agent_mcp_asyncroscopy.'))).toBe(true)
  expect(skill.steps[0].parameters.settings_json.mode).toBe('default')
  expect(skill.steps[1].parameters.fov.mode).toBe('default')
  expect(JSON.parse(skill.steps[0].parameters.settings_json.value).imsize).toBe(128)
  expect(skill.steps[1].parameters.fov.value).toBe(1e-8)
  const tool = nionSwiftHarnessToolName('agent_mcp_asyncroscopy', 'UnifiedDigitalTwin_acquire_scanned_image')
  expect(tool).toBe('mcp__asyncroscopy__UnifiedDigitalTwin_acquire_scanned_image')
  const names = [tool, 'mcp__nionswift_agent_sem__acquire_4d_stem', 'mcp__another__acquire', 'skill']
  expect(allowedToolNamesForRole('executor:agent_mcp_asyncroscopy', names)).toEqual(['skill', tool])
  expect(allowedToolNamesForRole('executor:agent_mcp_asyncroscopy@isolated-step', names)).toEqual(['skill', tool])
  expect(allowedToolNamesForRole('executor:agent_sem', names)).not.toContain(tool)
  expect(completionSatisfied(skill.steps[3].completion, {})).toBe(false)
  expect(completionSatisfied(skill.steps[3].completion, { structuredContent: { result: 'stem_image_HAADF_test.h5' } })).toBe(true)
})

it('discovers generic schemas without creating a NionSwift device or masking disconnected tools', async () => {
  let schemas = [{ name: 'mcp__asyncroscopy__UnifiedDigitalTwin_set_fov', parameters: { type: 'object', properties: { fov: { type: 'number' } } } }]
  const legacy = { status: async () => ({ ok: false, agents: [], agentInfo: {}, message: 'offline' }), listTools: async () => { throw new Error('No NionSwift call allowed') } }
  const view = workflowMcpView(legacy, () => schemas)
  expect((await view.status()).agents).toEqual(['agent_mcp_asyncroscopy'])
  expect((await view.listTools('agent_mcp_asyncroscopy')).tools[0].name).toBe('UnifiedDigitalTwin_set_fov')
  schemas = []
  expect((await view.status()).ok).toBe(false)
  expect((await view.listTools('agent_mcp_asyncroscopy')).tools).toEqual([])
})

it('blocks a contracted digital-twin acquisition without an approved workflow', async () => {
  const workflow = new EdmoreWorkflow({} as never, {} as never,
    resolve(import.meta.dirname, '../../../skills'))
  workflow.bindHarnessSession('native-demo', 'demo')
  await expect(workflow.beforeLoopToolCall('native-demo', 'agent_mcp_asyncroscopy',
    'UnifiedDigitalTwin_acquire_scanned_image', { detector_list: ['HAADF'] }, 'test'))
    .rejects.toThrow('approve its PlanReview')
})

it('generates and structurally judges the exact four-step demo against generic MCP schemas', async () => {
  const fields = { UnifiedDigitalTwin_set_scan_settings: { settings_json: { type: 'string' } },
    UnifiedDigitalTwin_set_fov: { fov: { type: 'number' } }, UnifiedDigitalTwin_auto_focus: {},
    UnifiedDigitalTwin_acquire_scanned_image: { detector_list: { type: 'array', items: { type: 'string' } } } }
  const view = workflowMcpView({ status: async () => ({ ok: false, agents: [], agentInfo: {}, message: '' }) },
    () => Object.entries(fields).map(([name, properties]) => ({ name: `mcp__asyncroscopy__${name}`,
      parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } })))
  const workflow = new EdmoreWorkflow({} as never, view, resolve(import.meta.dirname, '../../../skills')) as any
  const plan = await workflow.generatePlan('demo-plan', 'asyncroscopy_haadf_demo')
  expect(plan.steps).toHaveLength(4)
  expect(plan.steps[0].arguments.settings_json).toContain('128')
  expect(plan.steps[3].arguments).toEqual({ detector_list: ['HAADF'] })
  expect(plan.steps.every(step => step.required_inputs.length === 0)).toBe(true)
  const report = await workflow.judgePlan(plan)
  expect(report.issues).toEqual([])
  plan.steps[0].arguments.settings_json = '{"imsize":256,"dwell_time":0.000001,"scan_region":[0,0,0.5,0.5],"output_format":".h5"}'
  plan.steps[1].arguments.fov = 5e-9
  expect((await workflow.judgePlan(plan)).issues).toEqual([])
})
