import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { loadSkillDirectory } from '../../../skill-format.mjs'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { builders } from '../../../scripts/build-tem-alignment-workflows.mjs'

const skillRoot = resolve(import.meta.dirname, '../../../skills')
const names = [
  'tem-twin-beam-alignment',
  'tem-twin-gun-tilt-alignment',
  'tem-twin-condenser-stigmation',
  'tem-twin-eucentric-alignment',
  'tem-twin-rotation-center-alignment',
  'tem-twin-objective-stigmation',
]

describe('TEM Twin AutoScript workflow skills', () => {
  it('keeps generated workflow files identical to their declarative source', async () => {
    for (const build of Object.values(builders)) {
      const graph = build()
      const actual = parse(await readFile(resolve(skillRoot, graph.folder, 'references/workflow.yaml'), 'utf8'))
      expect(actual).toEqual(graph.finish())
    }
  })
  it.each(names)('loads %s as a bounded workflow', async name => {
    const wrapper = await loadSkillDirectory(resolve(skillRoot, name))
    expect(wrapper.kind).toBe('compound_workflow')
    expect(wrapper.references[0]).toBe('tem_tango_device_selection')
    const skill = await loadSkillDirectory(resolve(skillRoot, wrapper.references[1].replaceAll('_', '-')))
    expect(skill.kind).toBe('workflow')
    expect(skill.steps).toHaveLength(1)
    expect(skill.steps.some(step => /run_?autoalign|center_beam_once|improve_gun_tilt_once/i.test(step.tool))).toBe(false)
    expect(skill.steps.every(step => step.tool.startsWith('agent_mcp_tem_twin.'))).toBe(true)
    expect(skill.steps.every(step => /^agent_mcp_tem_twin\.align_/.test(step.tool))).toBe(true)
    expect(skill.steps[0].completion).toEqual({ type: 'field_equals', field: 'verified', value: true })
    expect(skill.steps[0].on_failure).toBe('pause')
    expect(skill.steps[0].max_visits).toBe(1)
    expect(skill.steps[0].parameters.device).toEqual({ mode: 'result', value: '{{select_device.device}}' })
    expect(skill.steps.every(step => typeof step.on_error === 'string')).toBe(true)
    for (const step of skill.steps) {
      if (!['complete', 'next', 'pause'].includes(step.on_success) && skill.steps.findIndex(item => item.id === step.on_success) <= skill.steps.indexOf(step)) {
        expect(step.max_visits).toBeGreaterThan(0)
      }
    }
  })

  it('asks the user before selecting a device, without a fixed or default target', async () => {
    const selection = await loadSkillDirectory(resolve(skillRoot, 'tem-tango-device-selection'))
    expect(selection.steps[0].parameters.device).toEqual({ mode: 'ask' })
    expect(selection.steps[0].confirm).toBe(true)
    expect(selection.steps[0].tool).toBe('agent_mcp_tem_twin.select_device')
    expect(selection.steps[0].completion).toEqual({ type: 'field_equals', field: 'available', value: true })
  })

  it('does not expose the old flat shortcuts as a new executable workflow', async () => {
    const skill = await loadSkillDirectory(resolve(skillRoot, 'tem-twin-autoalignment'))
    expect(skill.kind).toBe('knowledge')
    expect(skill.steps).toHaveLength(0)
  })
})
