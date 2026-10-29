import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PlanSkillAdapter, evidenceIssues } from '../src/skills.ts'
import { EdmoreWorkflow } from './workflow-fixture.ts'
import { nativeMcpToolName, workflowToolSchemaName } from '../../runtime/src/workflow-mcp.ts'

it('selects a device before six tools and preserves approval and execution-result gates', async () => {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  ctx.skills.registerProvider(control => new FileSystemSkillProvider(ctx, control, {
    includeDefaultRoots: false, watch: false,
    customSkillDirs: [resolve(import.meta.dirname, '../../../skills')],
  }))
  try {
    const evidence = await new PlanSkillAdapter(ctx.skills, {}).prepare('tem-twin-alignment-sequence')
    const catalog = await new PlanSkillAdapter(ctx.skills, {}).catalog()
    expect(catalog.find(skill => skill.name === 'tem-twin-alignment-sequence')?.description).toContain('ALL SIX')
    expect(catalog.find(skill => skill.name === 'tem-twin-beam-alignment')?.description).toContain('ONLY')
    const [parent, ...children] = evidence.workflow_contracts
    expect(children.map(child => child.skill_id)).toEqual([
      'tem_tango_device_selection', 'tem_twin_phase_beam', 'tem_twin_phase_gun',
      'tem_twin_phase_c2stig', 'tem_twin_phase_z', 'tem_twin_phase_rot', 'tem_twin_phase_ostig',
    ])
    expect(evidenceIssues(evidence)).toEqual([])
    const bridge = {
      async status() { return { ok: true, agents: ['agent_mcp_tem_twin'] } },
      async listTools() {
        return { tools: [...new Set(children.flatMap(child => child.required_tools))].map(tool => ({
          name: workflowToolSchemaName('agent_mcp_tem_twin', tool.split('.').slice(1).join('.')), inputSchema: { type: 'object', properties: { device: { type: 'string' } }, required: ['device'] },
        })) }
      },
    }
    const workflow = new EdmoreWorkflow({ append: async (event: unknown) => event } as never, bridge as never, '') as any
    workflow.saveState = async () => {}
    workflow.completeActiveWorkflow = vi.fn(async () => {})
    workflow.handleRuntimeBlocker = vi.fn(async () => {})
    const raw = { steps: children.flatMap(child => child.steps!.map(step => ({
      skill: child.skill_id, skill_step_id: step.id,
      agent: 'agent_mcp_tem_twin', tool_name: step.tool.split('.').slice(1).join('.'),
    }))) }
    const plan = workflow.normalizePlannerPlan('test', 'Align the TEM Twin', 'session', parent, children,
      evidence.workflow_contracts, JSON.stringify(raw))
    plan.skill_evidence = evidence
    const report = await workflow.judgePlan(plan)
    expect(report.issues).toEqual([])
    expect(report.status).toBe('pass')
    for (const child of children) {
      const phase = plan.steps.filter((step: any) => step.skill === child.skill_id)
      expect(phase.map((step: any) => step.skill_step_id)).toEqual(child.steps!.map(step => step.id))
      for (const step of phase) {
        const template = child.steps!.find(item => item.id === step.skill_step_id)!
        expect(step.completion).toEqual(template.completion)
        expect(step.max_visits).toBe(template.max_visits)
        expect(step.on_success).toBe(template.on_success)
        expect(step.on_failure).toBe(template.on_failure)
        for (const [key, binding] of Object.entries(template.parameters)) {
          if (binding.mode === 'result') expect(step.arguments[key]).toBe(binding.value)
        }
      }
    }
    for (const [index, child] of children.entries()) {
      const exitIndex = plan.steps.findIndex((step: any) => step.skill === child.skill_id && step.on_success === 'complete')
      expect(exitIndex).toBeGreaterThanOrEqual(0)
      const active = { plan, nextStepIndex: exitIndex, stepVisits: {} }
      workflow.activeBySession.set('session', active)
      const exitStep = plan.steps[exitIndex]
      expect(await workflow.followStepTransition(active, exitStep, 'complete', 'success', 'session', 'test')).toBe(true)
      if (index < children.length - 1) {
        expect(plan.steps[active.nextStepIndex].skill).toBe(children[index + 1].skill_id)
        expect(plan.steps[active.nextStepIndex].skill_step_id).toBe(children[index + 1].steps![0].id)
        expect(workflow.completeActiveWorkflow).not.toHaveBeenCalled()
      } else expect(workflow.completeActiveWorkflow).toHaveBeenCalledOnce()
    }
    workflow.activeBySession.delete('session')
    expect(plan.steps).toHaveLength(7)
    expect(plan.steps[0].required_inputs.join(' ')).toContain('device')
    const evidenceStore = workflow.sessionState
    workflow.sessionState = { ...evidenceStore, stepResult: (_session: string, _workflow: string, stepId: string) =>
      stepId === plan.steps[0].step_id ? { structuredContent: { device: 'edmore/tem/twin_b', available: true } } : undefined }
    for (const step of plan.steps.slice(1)) {
      expect(workflow.resolveStepArguments(plan, step).device).toBe('edmore/tem/twin_b')
    }
    workflow.sessionState = { ...evidenceStore, stepResult: () => undefined }
    expect(() => workflow.resolveStepArguments(plan, plan.steps[1])).toThrow('Missing result')
    workflow.sessionState = evidenceStore
    workflow.sessionState.stepResult = () => ({ structuredContent: { device: 'edmore/tem/twin_b', available: true } })
    const reordered = { ...plan, steps: [...plan.steps].reverse() }
    expect((await workflow.judgePlan(reordered)).issues.some((issue: any) => issue.message.includes('child order'))).toBe(true)
    const objective = plan.steps[6]
    const publicName = nativeMcpToolName('tem_twin', objective.tool_name)
    expect(publicName).toBe('mcp__tem_twin__align_objective_stigmation')
    workflow.bindHarnessSession('harness', 'session')
    workflow.loadSkillContracts = async () => new Map(evidence.workflow_contracts.map(contract => [contract.skill_id, contract]))
    await expect(workflow.beforeLoopToolCall('harness', objective.agent, objective.tool_name, {}, 'unapproved')).rejects.toThrow('approve its PlanReview')
    const execution = { plan, nextStepIndex: 1, stepVisits: {} }
    workflow.activeBySession.set('session', execution)
    const beam = plan.steps[1]
    await expect(workflow.beforeLoopToolCall('harness', objective.agent, objective.tool_name, {}, 'wrong-order')).rejects.toThrow('out-of-order')
    await expect(workflow.beforeLoopToolCall('harness', beam.agent, beam.tool_name, { device: 'edmore/tem/twin_a' }, 'wrong-device')).rejects.toThrow()
    await expect(workflow.beforeLoopToolCall('harness', beam.agent, beam.tool_name, { device: 'edmore/tem/twin_b' }, 'approved')).resolves.toBe(true)
    workflow.registerDecisionProvider({ shouldPlan: async () => undefined, assessStep: async () => ({ status: 'success', reason: 'Verified evidence' }) })
    await workflow.afterLoopToolResult('harness', beam.agent, beam.tool_name, 'approved', { structuredContent: { success: true, verified: true } })
    expect(execution.nextStepIndex).toBe(2)
    const gun = plan.steps[2]
    await workflow.afterLoopToolResult('harness', gun.agent, gun.tool_name, 'not-converged', { structuredContent: { success: false, verified: false } })
    expect(execution.nextStepIndex).toBe(2)
    expect(workflow.handleRuntimeBlocker).toHaveBeenCalled()
    workflow.assessStepResult = async () => ({ status: 'failure', reason: 'Contradictory measurement evidence' })
    await workflow.afterLoopToolResult('harness', gun.agent, gun.tool_name, 'judge-veto', { structuredContent: { success: true, verified: true } })
    expect(execution.nextStepIndex).toBe(2)
    bridge.listTools = async () => ({ tools: [] })
    expect((await workflow.judgePlan(plan)).issues.some((issue: any) => issue.step_id === objective.step_id && issue.category === 'tool')).toBe(true)
  } finally { await ctx.fiber.dispose() }
})

it('instructs proposal routing to treat broader alignment as a revision, not approval of one child', async () => {
  const workflow = new EdmoreWorkflow({} as never, {} as never, '')
  workflow.bindRoleRunner({
    async runRoleOnce(_session, role, prompt) {
      expect(role).toBe('orchestrator')
      expect(prompt).toContain('Approval must preserve the proposed scope')
      expect(prompt).toContain('Digital Twin alignment after a beam/C2-only proposal means overall alignment')
      expect(prompt).toContain('做digitial twin的alighnment')
      return JSON.stringify({ intent: 'revise', reason: 'The user requests overall alignment, not just beam/C2.' })
    },
  })
  const intent = await workflow['classifyPlanningProposalIntent']('做digitial twin的alighnment', {
    event_id: 'test', cursor: 1, timestamp: '', source: 'test', type: 'edmore.trigger.requested',
    scope: 'workflow', session_id: 'session', payload: {},
  }, { proposal_id: 'old', session_id: 'session', prompt: 'Align beam/C2 only',
    plan_goal: 'Use tem-twin-beam-alignment for beam shift and C2 only', reason: 'Align beam/C2',
  } as never)
  expect(intent).toBe('revise')
})
