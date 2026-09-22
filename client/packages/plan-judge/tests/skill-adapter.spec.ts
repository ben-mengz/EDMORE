import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry, type SkillDefinition } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { createScope } from '@deepseek-ai/dsh-scope'
import { resolve } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { EdmoreWorkflow } from './workflow-fixture.ts'
import { PlanSkillAdapter, evidenceIssues, type SkillRegistryReader } from '../src/skills.ts'
import { renderSupportMarkdown } from '../../../skill-format.mjs'
import { SessionStateStore } from '../../session-state/src/core.ts'

function definition(name: string, metadata: Record<string, unknown> = {}): SkillDefinition {
  return { name, description: name, content: `Instructions for ${name}`, provider: 'fixture', source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true }, metadata }
}

function workflowDefinition(name = 'custom-wait'): SkillDefinition {
  return definition(name, { edmore: { authority: 'workflow', workflow: {
    schema_version: 1, id: name.replace(/-/g, '_'), version: '1.0.0', steps: [{
      id: 'wait', title: 'Wait', purpose: 'Wait for readiness', tool: 'agent_sem.wait',
      parameters: { seconds: { mode: 'fixed', value: 7 } }, confirm: false,
      completion: { type: 'tool_success' }, on_success: 'next', on_failure: 'pause',
    }],
  } } })
}

function registryFixture(rows = [workflowDefinition(), definition('dose-notes'), definition('unrelated')]) {
  const registry: SkillRegistryReader = {
    snapshot: vi.fn(async () => ({ complete: true, skills: rows })),
    get: vi.fn(async name => structuredClone(rows.find(row => row.name === name))),
  }
  return { registry, rows }
}

const bridge = {
  async status() { return { ok: true, agents: ['agent_sem'], agentInfo: {}, message: '' } },
  async listTools() { return { tools: [{ name: 'wait', inputSchema: { type: 'object', properties: { seconds: { type: 'number' } } } }] } },
}

describe('native skill adapter', () => {
  it('reads desktop support Markdown through Harness without granting workflow authority', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'edmore-support-registry-'))
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    try {
      const skillRoot = resolve(directory, 'dose-notes')
      await mkdir(skillRoot)
      await writeFile(resolve(skillRoot, 'SKILL.md'), renderSupportMarkdown('dose-notes', 'Review dose estimates.', 'Dose notes', '# Notes\n\nReview measured beam current.'))
      ctx.skills.registerProvider(control => new FileSystemSkillProvider(ctx, control, {
        includeDefaultRoots: false, watch: false, customSkillDirs: [directory],
      }))
      ctx.skills.register(workflowDefinition())
      const adapter = new PlanSkillAdapter(ctx.skills, { cwd: directory })
      const evidence = await adapter.prepare('custom-wait', ['dose-notes'])
      expect(evidence.supporting_skills[0].content).toContain('measured beam current')
      await expect(adapter.contract('dose-notes')).rejects.toThrow('supporting material')
    } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })

  it('loads only the selected workflow and supporting material with the caller view', async () => {
    const { registry } = registryFixture()
    const view = { cwd: '/example/workspace', scope: {}, signal: new AbortController().signal }
    const adapter = new PlanSkillAdapter(registry, view)
    await adapter.catalog()
    expect(registry.get).not.toHaveBeenCalled()
    const evidence = await adapter.prepare('custom-wait', ['dose-notes'])
    expect(registry.get).toHaveBeenCalledTimes(2)
    expect(registry.get).toHaveBeenCalledWith('dose-notes', view)
    expect(evidence.workflow_contracts).toHaveLength(1)
    expect(evidence.supporting_skills[0].content).toContain('dose-notes')
    expect(evidenceIssues(JSON.parse(JSON.stringify(evidence)))).toEqual([])
    await expect(adapter.contract('dose-notes')).rejects.toThrow('supporting material')
  })

  it('rejects incomplete discovery and disabled or unavailable skills', async () => {
    const { registry, rows } = registryFixture()
    rows[0].invocation = { modelInvocable: false, userInvocable: true }
    const adapter = new PlanSkillAdapter(registry, {})
    await expect(adapter.prepare('custom-wait')).rejects.toThrow('not available')
    expect(registry.get).not.toHaveBeenCalled()
    vi.mocked(registry.snapshot).mockResolvedValue({ skills: rows, complete: false })
    await expect(adapter.catalog()).rejects.toThrow('incomplete')
  })

  it('rejects malformed workflow declarations instead of granting authority', async () => {
    const { registry } = registryFixture([definition('invalid', { edmore: { authority: 'workflow', workflow: {} } })])
    await expect(new PlanSkillAdapter(registry, {}).prepare('invalid')).rejects.toThrow('Invalid EDMORE workflow')
  })

  it('uses the real native registry and filesystem provider for compound legacy bundles', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const dispose = ctx.skills.registerProvider(control => new FileSystemSkillProvider(ctx, control, {
      includeDefaultRoots: false, watch: false, customSkillDirs: [resolve(import.meta.dirname, '../../../skills')],
    }))
    try {
      const adapter = new PlanSkillAdapter(ctx.skills, { cwd: process.cwd() })
      const result = await adapter.prepare('ptychography-on-sem', ['recommend-4d-stem-parameters'])
      expect(result.workflow_contracts.map(item => item.skill_id)).toEqual(['ptychography_on_sem', 'acquire_4d_stem', 'ptychography'])
      expect(result.supporting_skills[0].name).toBe('recommend-4d-stem-parameters')
      const recommendation = await adapter.prepare('recommend-4d-stem-parameters')
      expect(recommendation.contract_skill.confirmation_steps?.[0].id).toBe('accept-settings')
      expect(recommendation.contract_skill.ordered_tools).not.toContain('agent_suggestion.update_parameters')
      expect(recommendation.contract_skill.optional_tools).toContain('agent_suggestion.update_parameters')
      expect(result.workflow_contracts[1].steps).toHaveLength(7)
      expect(evidenceIssues(result)).toEqual([])
    } finally { dispose(); await ctx.fiber.dispose() }
  })

  it('uses the native scoped winner rather than an executable global definition', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    ctx.skills.register(workflowDefinition())
    const key = {}
    const scope = createScope(ctx, key)
    await scope.ctx.plugin({ inject: ['skills'], apply(scoped: Context) { scoped.skills.register(definition('custom-wait')) } })
    try {
      expect((await new PlanSkillAdapter(ctx.skills, {}).prepare('custom-wait')).workflow_contracts).toHaveLength(1)
      await expect(new PlanSkillAdapter(ctx.skills, { scope: key }).prepare('custom-wait')).rejects.toThrow('supporting material')
    } finally { await scope.dispose(); await ctx.fiber.dispose() }
  })

  it('rejects broken and cyclic compound references', async () => {
    const { registry } = registryFixture()
    const adapter = new PlanSkillAdapter(registry, {})
    const base = await adapter.contract('custom-wait')
    vi.spyOn(adapter, 'contract').mockResolvedValue({ ...base, references: ['custom_wait'] })
    await expect(adapter.prepare('custom-wait')).rejects.toThrow('Cyclic')
    vi.mocked(adapter.contract).mockResolvedValue({ ...base, references: ['missing'] })
    await expect(adapter.prepare('custom-wait')).rejects.toThrow('unavailable')
  })
})

describe('PlanJudge skill evidence', () => {
  it('uses the independent state plugin for judge evidence and records reproducible input versions', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'edmore-judge-state-'))
    try {
      const store = new SessionStateStore(directory)
      await store.ready()
      let counter = 0
      const { registry } = registryFixture()
      const hub = { async append(input: any) {
        const event = { ...input, event_id: `hub-${++counter}`, timestamp: new Date().toISOString(), cursor: counter }
        store.record(event)
        return event
      } }
      const workflow = new EdmoreWorkflow(hub, bridge, '', undefined, 0, registry)
      workflow.bindSessionState(store)
      const plan = await workflow['generatePlan']('plugin-plan', 'custom-wait', 'session')
      plan.steps[0].required_inputs = ['confirm_roi']
      workflow['pausedBySession'].set('session', { plan, reason: 'Confirm ROI', state: { next_step_index: 0 } })
      workflow.bindHarnessSession('harness', 'session')
      let inputPacket: any
      workflow.bindRoleRunner({ async runRoleOnce(_session, role, prompt) {
        expect(role).toBe('judge')
        const serialized = prompt.split('Shared execution context (state and source events):\n')[1].split('\n\n')[0]
        inputPacket = JSON.parse(serialized)
        expect(inputPacket.state.workflows['plugin-plan'].gates['1'].confirmation_context).toEqual({ button: 'confirm_roi', roi: 12 })
        expect(inputPacket.events.some((row: any) => row.event.type === 'tool.result')).toBe(true)
        return '{"status":"success","reason":"Accepted user confirmation and successful wait."}'
      } })
      await workflow.resume(plan.workflow_id, 'session', 'ROI confirmed', 'ui-confirmation', { button: 'confirm_roi', roi: 12 })
      await workflow.beforeLoopToolCall('harness', 'agent_sem', 'wait', { seconds: 7 }, 'call')
      await workflow.afterLoopToolResult('harness', 'agent_sem', 'wait', 'call', { content: [{ type: 'text', text: 'Waited for 7 seconds.' }] })
      expect(plan.execution_context).toBeUndefined()
      expect(store.evidence('session', [plan.workflow_id], inputPacket.version).digest).toBe(inputPacket.digest)
      const used = store.events('session', 0, 1000).find(row => row.event.type === 'edmore.context.used' && (row.event.payload as any).consumer === 'result-judge')!
      expect((used.event.payload as any).digest).toBe(inputPacket.digest)
      await store.flush()
      const restored = new SessionStateStore(directory)
      await restored.ready()
      expect(restored.evidence('session', [plan.workflow_id], inputPacket.version)).toEqual(inputPacket)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('shares persisted user, button and tool evidence across judge, executor and child lineage', async () => {
    const { registry } = registryFixture()
    const workflow = new EdmoreWorkflow({ append: async value => value } as never, bridge, '', undefined, 0, registry)
    const parent = await workflow['generatePlan']('parent-evidence', 'custom-wait: Use defocus 1200 from my query', 'session')
    workflow['recordExecutionContext'](parent, 'edmore.trigger.requested', 'edmore-trigger-router', {
      prompt: 'ROI confirmed', source_event: { event_id: 'ui-42', source: 'nionswift-mcp', payload: { roi: { width: 25 }, button: 'confirm_roi' } },
    }, 'routed-42', '1')
    workflow['recordExecutionContext'](parent, 'tool.call', 'agent_sem', { arguments: { seconds: 7 }, call_id: 'call-42' }, 'call-42', '1')
    workflow['recordExecutionContext'](parent, 'tool.result', 'agent_sem', { result: { content: [{ type: 'text', text: 'Measured value 23' }] }, call_id: 'call-42' }, 'call-42', '1')
    const restored = JSON.parse(JSON.stringify(parent))
    const child = await workflow['generatePlan']('child-evidence', 'custom-wait: Recover readiness', 'session')
    child.parent_return = { workflow_id: parent.workflow_id, session_id: 'session', plan: restored, next_step_index: 0, reason: 'Not ready' }
    workflow.bindRoleRunner({ async runRoleOnce(_session, role, prompt) {
      expect(prompt).toContain('Use defocus 1200 from my query')
      expect(prompt).toContain('ui-42')
      expect(prompt).toContain('"width":25')
      expect(prompt).toContain('Measured value 23')
      return role === 'judge' ? '{"status":"success","reason":"Evidence available."}' : '{"needs_subplan":false}'
    } })
    expect((await workflow['assessStepResult'](child, child.steps[0], { content: [] }, 'session', 'judge')).status).toBe('success')
    await workflow['proposeRuntimeSubplan'](child, child.steps[0], 0, 'Not ready', 'session', 'recovery')
    expect(workflow['formatStepLoopPrompt'](child, 0, child.steps[0])).toContain('ui-42')
    workflow['roleRunner'] = undefined
    const unrelated = await workflow['generatePlan']('unrelated', 'custom-wait', 'other-session')
    expect(JSON.stringify(workflow['executionContext'](unrelated))).not.toContain('ui-42')
  })

  it('passes accepted UI or chat confirmation to the result judge only for the resumed step', async () => {
    const { registry } = registryFixture()
    const workflow = new EdmoreWorkflow({ append: async value => value } as never, bridge, '', undefined, 0, registry)
    const plan = await workflow['generatePlan']('confirmation', 'custom-wait', 'session')
    plan.steps[0].required_inputs = ['confirm_roi_selection_after_pixel_sync']
    plan.steps.push({ ...plan.steps[0], step_id: '2', required_inputs: [] })
    workflow.bindHarnessSession('harness', 'session')
    workflow['pausedBySession'].set('session', { plan, reason: 'Confirm ROI', state: { next_step_index: 0 } })
    const confirmations: boolean[] = []
    workflow.bindRoleRunner({ async runRoleOnce(_session, role, prompt) {
      expect(role).toBe('judge')
      const evidence = JSON.parse(prompt.split('Harness confirmation gate state:\n')[1].split('\n\n')[0])
      confirmations.push(evidence.accepted_for_current_step)
      expect(evidence.step_id).toBe(String(confirmations.length))
      return '{"status":"success","reason":"Wait completed; user gate evaluated separately from the tool result."}'
    } })
    await workflow.resume(plan.workflow_id, 'session', 'confirm', 'user-confirmation', { status: 'success', tool_name: 'confirm_roi_selection' })
    await workflow.beforeLoopToolCall('harness', 'agent_sem', 'wait', { seconds: 7 }, 'first')
    await workflow.afterLoopToolResult('harness', 'agent_sem', 'wait', 'first', { content: [{ type: 'text', text: 'Waited for 7 seconds.' }] })
    expect(workflow['activeBySession'].get('session')?.nextStepIndex).toBe(1)
    expect(workflow['activeBySession'].get('session')?.confirmedStepIndex).toBeUndefined()
    await workflow.beforeLoopToolCall('harness', 'agent_sem', 'wait', { seconds: 7 }, 'second')
    await workflow.afterLoopToolResult('harness', 'agent_sem', 'wait', 'second', { content: [{ type: 'text', text: 'Waited for 7 seconds.' }] })
    expect(confirmations).toEqual([true, false])
  })

  it('cancels only the selected paused workflow after hardware verification', async () => {
    const { registry } = registryFixture()
    const append = vi.fn(async value => value)
    const workflow = new EdmoreWorkflow({ append } as never, bridge, '', undefined, 0, registry)
    const plan = await workflow['generatePlan']('cancel-test', 'custom-wait', 'session')
    workflow['pausedBySession'].set('session', { plan, reason: 'Waiting', state: { next_step_index: 0 } })
    workflow['activeBySession'].set('session', { plan, nextStepIndex: 0 })
    workflow['updateInstrumentLeases']('session', plan, 'paused', 'Waiting')
    await expect(workflow.cancelPaused('wrong', 'session', true)).rejects.toThrow('no longer paused')
    await expect(workflow.cancelPaused(plan.workflow_id, 'session', false)).rejects.toThrow('Verify')
    workflow['inFlightToolCalls'].set('session', { callId: 'in-flight' } as never)
    await expect(workflow.cancelPaused(plan.workflow_id, 'session', true)).rejects.toThrow('in flight')
    expect(workflow['pausedBySession'].has('session')).toBe(true)
    workflow['inFlightToolCalls'].delete('session')
    await workflow.cancelPaused(plan.workflow_id, 'session', true)
    expect(workflow['pausedBySession'].has('session')).toBe(false)
    expect(workflow['activeBySession'].has('session')).toBe(false)
    expect((workflow.state() as any).instrument_leases).toHaveLength(0)
    expect(append.mock.calls.some(([event]) => event.type === 'edmore.workflow.cancelled')).toBe(true)
    expect(workflow['archived']).toContain(plan)
  })

  it('cancels a paused child chain through the parent instrument lease', async () => {
    const { registry } = registryFixture()
    const append = vi.fn(async value => value)
    const workflow = new EdmoreWorkflow({ append } as never, bridge, '', undefined, 0, registry)
    const parent = await workflow['generatePlan']('parent', 'custom-wait', 'session')
    const child = { ...parent, workflow_id: 'child', parent_return: { workflow_id: 'parent', plan: parent, next_step_index: 0, reason: 'Recovery' } }
    workflow['pausedBySession'].set('session', { plan: child, reason: 'Waiting', state: { next_step_index: 0 } })
    workflow['activeBySession'].set('session', { plan: child, nextStepIndex: 0 })
    workflow['updateInstrumentLeases']('session', parent, 'paused', 'Waiting for child')
    await expect(workflow.cancelPaused('parent', 'other-session', true)).rejects.toThrow('no longer paused')
    await expect(workflow.cancelPaused('parent', 'session', false)).rejects.toThrow('Verify')
    await workflow.cancelPaused('parent', 'session', true)
    expect(workflow['pausedBySession'].size).toBe(0)
    expect(workflow['activeBySession'].size).toBe(0)
    expect((workflow.state() as any).instrument_leases).toHaveLength(0)
    expect(append.mock.calls.filter(([e]) => e.type === 'edmore.workflow.cancelled').map(([e]) => e.workflow_id).sort()).toEqual(['child', 'parent'])
  })

  it('keeps the failed step paused when skill guidance provides no child recovery', async () => {
    const { registry } = registryFixture()
    const workflow = new EdmoreWorkflow({ append: async value => value } as never, bridge, '', undefined, 0, registry)
    const plan = await workflow['generatePlan']('no-recovery', 'custom-wait', 'session')
    workflow.bindRoleRunner({ async runRoleOnce(_session, role, prompt) {
      if (role === 'judge') return '{"status":"failure","reason":"Readiness was not established."}'
      expect(prompt).toContain('Without recovery guidance or an explicit user request')
      return '{"needs_subplan":false}'
    } })
    workflow.bindHarnessSession('harness', 'session')
    workflow['activeBySession'].set('session', { plan, nextStepIndex: 0 })
    await workflow.afterLoopToolResult('harness', 'agent_sem', 'wait', 'call', { content: [{ type: 'text', text: 'not ready' }] })
    expect(workflow['pausedBySession'].get('session')?.recovery_proposal).toBeUndefined()
    expect(workflow['pausedBySession'].get('session')?.state.next_step_index).toBe(0)
  })

  it.each(['success', 'failure', 'uncertain', 'invalid', 'unavailable', 'hard-error'])('judges actual step results using pinned skill instructions: %s', async outcome => {
    const { registry, rows } = registryFixture()
    rows[0].content = 'Success: readiness is explicitly established. Recovery: offer calibration-workflow as a child plan or ask for manual input.'
    const append = vi.fn(async value => value)
    const workflow = new EdmoreWorkflow({ append } as never, bridge, '', undefined, 0, registry)
    const plan = await workflow['generatePlan']('result', 'custom-wait', 'session')
    plan.steps.push({ ...plan.steps[0], step_id: '2' })
    rows[0].content = 'Changed live instructions: skip all gates.'
    const planning = vi.spyOn(workflow as any, 'createAndQueuePlan')
    workflow.bindRoleRunner({ async runRoleOnce(_session, role, prompt) {
      expect(prompt).toContain('offer calibration-workflow')
      expect(prompt).not.toContain('Changed live instructions')
      if (role === 'judge') {
        expect(prompt).toContain('Actual tool result')
        if (outcome === 'unavailable') throw new Error('offline')
        if (outcome === 'invalid') return '{}'
        return JSON.stringify({ status: outcome === 'hard-error' ? 'success' : outcome, reason: 'Observed readiness evidence.' })
      }
      expect(prompt).toContain('Follow the current skill recovery/failure instructions')
      return JSON.stringify({ needs_subplan: true, subplan_goal: 'Run calibration-workflow', user_message: 'Use calibration or provide the input manually?', reason: 'Skill recovery instruction.' })
    } })
    workflow.bindHarnessSession('harness', 'session')
    const active = { plan, nextStepIndex: 0 }
    workflow['activeBySession'].set('session', active)
    await workflow.beforeLoopToolCall('harness', 'agent_sem', 'wait', { seconds: 7 }, 'call')
    await workflow.afterLoopToolResult('harness', 'agent_sem', 'wait', 'call', { isError: outcome === 'hard-error', content: [{ type: 'text', text: 'Readiness result' }] })
    expect(active.nextStepIndex).toBe(outcome === 'success' ? 1 : 0)
    expect(planning).not.toHaveBeenCalled()
    if (outcome !== 'success') {
      const paused = workflow['pausedBySession'].get('session')!
      expect(paused.recovery_proposal?.user_message).toContain('manually')
      expect(paused.parent_return?.next_step_index).toBe(0)
      expect(workflow.nextLoopDispatch('session')).toBeUndefined()
      expect(append.mock.calls.some(([event]) => event.type === 'edmore.custom.subplan.proposed' && event.payload.awaits_user_approval_to_plan)).toBe(true)
    }
  })

  it.each([
    { content: [{ type: 'text', text: 'Error: No defocus value provided. Please provide a defocus value in the UI or chat.' }], isError: false },
    { content: [{ type: 'text', text: "You didn't select the data properly, please select a 4d-stem data--ptychography agent job" }], isError: false },
    { content: [], structuredContent: { success: false } },
  ])('does not advance after a tool failure returned as a successful MCP response: %j', async result => {
    const { registry } = registryFixture()
    const append = vi.fn(async value => value)
    const workflow = new EdmoreWorkflow({ append } as never, bridge, '', undefined, 0, registry)
    const plan = await workflow['generatePlan']('failure', 'custom-wait', 'session')
    plan.steps.push({ ...plan.steps[0], step_id: '2' })
    workflow.bindHarnessSession('harness', 'session')
    const active = { plan, nextStepIndex: 0 }
    workflow['activeBySession'].set('session', active)
    await workflow.beforeLoopToolCall('harness', 'agent_sem', 'wait', { seconds: 7 }, 'call')
    await workflow.afterLoopToolResult('harness', 'agent_sem', 'wait', 'call', result)
    expect(active.nextStepIndex).toBe(0)
    expect(append.mock.calls.some(([event]) => event.type === 'edmore.hardware.observed')).toBe(false)
    expect(append.mock.calls.some(([event]) => event.type === 'edmore.workflow.paused')).toBe(true)
    await expect(workflow.beforeLoopToolCall('harness', 'agent_sem', 'wait', { seconds: 7 }, 'next')).rejects.toThrow()
  })

  it('reports blocked chat approval without removing the pending plan', async () => {
    const { registry } = registryFixture()
    const append = vi.fn(async value => value)
    const workflow = new EdmoreWorkflow({ append } as never, bridge, '', undefined, 0, registry)
    const plan = await workflow['generatePlan']('pending', 'custom-wait', 'session')
    plan.judge_report = { status: 'pass', grounding_status: 'fully_grounded', summary: 'Fixture reviewed', issues: [] }
    workflow['pending'].set(plan.workflow_id, plan)
    workflow['pendingBySession'].set('session', plan.workflow_id)
    workflow.bindRoleRunner({ async runRoleOnce() { return '{"intent":"approve"}' } })
    vi.spyOn(workflow as any, 'assertInstrumentAvailable').mockImplementation(() => { throw new Error('Instrument occupied by another paused workflow') })
    const result = await workflow.handleTrigger({ event_id: 'approval-test', session_id: 'session', payload: { prompt: 'go ahead' } } as never)
    expect(result.action).toBe('blocked')
    expect(result.message).toContain('Instrument occupied')
    expect(workflow['pending'].has(plan.workflow_id)).toBe(true)
    expect(append.mock.calls.some(([event]) => event.payload?.text?.includes('Instrument occupied'))).toBe(true)
    expect(append.mock.calls.some(([event]) => event.type === 'edmore.approval.granted')).toBe(false)
    workflow['activeBySession'].set('old-session', { plan, nextStepIndex: 0 })
    expect((workflow.state() as any).active[0].plan.workflow_id).toBe(plan.workflow_id)
  })

  it('resolves compound labels only to unique declared descendants', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    ctx.skills.registerProvider(control => new FileSystemSkillProvider(ctx, control, {
      includeDefaultRoots: false, watch: false, customSkillDirs: [resolve(import.meta.dirname, '../../../skills')],
    }))
    try {
      const evidence = await new PlanSkillAdapter(ctx.skills, {}).prepare('ptychography-on-sem', ['recommend-4d-stem-parameters'])
      const [parent, acquisition, reconstruction] = evidence.workflow_contracts
      const workflow = new EdmoreWorkflow({} as never, bridge, '')
      const normalize = (skill: string, tool_name: string, contracts = evidence.workflow_contracts) => workflow['normalizePlannerPlan'](
        'test', 'ptychography', 'session', parent, [acquisition, reconstruction], contracts,
        JSON.stringify({ steps: [{ skill, agent: 'agent_sem', tool_name }] }),
      )
      const plan = normalize(parent.skill_id, 'play_bf')
      expect(plan.steps[0].skill).toBe('acquire_4d_stem')
      expect(plan.steps[0].tool_name).toBe('play_bf')
      expect(normalize(parent.skill_id, 'agent_sem.play_bf').steps[0].skill).toBe('acquire_4d_stem')
      expect(() => normalize(parent.skill_id, 'invented')).toThrow('undeclared action')
      expect(() => normalize(reconstruction.skill_id, 'play_bf')).toThrow('undeclared action')
      expect(evidence.supporting_skills[0].name).toBe('recommend-4d-stem-parameters')
      expect(() => normalize('recommend-4d-stem-parameters', 'load_q_spec')).toThrow('Supporting instructions do not authorize execution')
      expect(() => normalize('recommend_4d_stem_parameters', 'load_q_spec')).toThrow('undeclared workflow')
      const ambiguous = { ...reconstruction, optional_tools: ['agent_sem.play_bf'] }
      expect(() => normalize(parent.skill_id, 'play_bf', [parent, acquisition, ambiguous])).toThrow('undeclared action')
      const prompt = await workflow['formatPlannerPrompt']('test', 'ptychography', parent, [acquisition, reconstruction], evidence.workflow_contracts)
      expect(prompt).toContain('"skill": "acquire_4d_stem"')
      expect(prompt).toContain('Authorized execution contracts (the complete allowlist for steps)')
      expect(prompt).toContain('Conditional recovery instructions in a skill are not normal execution steps')
      expect(prompt).not.toContain('You may include supporting skills when')
    } finally { await ctx.fiber.dispose() }
  })

  it('passes selected general instructions into the planning call and rejects invented actions', async () => {
    const { registry } = registryFixture([workflowDefinition('wait-workflow'), definition('dose-notes')])
    const workflow = new EdmoreWorkflow({} as never, bridge, '', undefined, 0, registry)
    let calls = 0
    let invent = false
    const view = { cwd: '/workspace', scope: {} }
    workflow.bindRoleRunner({
      async skillView(session, role) { expect(session).toBe('session'); expect(role).toBe('planner'); return view },
      async runRoleOnce(_session, _role, prompt) {
        calls++
        if (calls % 2 === 1) return '{"contract_skill":"wait-workflow","supporting_skills":["dose-notes"]}'
        expect(prompt).toContain('Instructions for dose-notes')
        return JSON.stringify({ goal: 'Wait', steps: [{ skill: 'wait_workflow', skill_step_id: 'wait', agent: 'agent_sem', tool_name: invent ? 'invented' : 'wait' }] })
      },
    })
    const plan = await workflow['generatePlan']('test', 'wait', 'session')
    expect((await workflow['judgePlan'](plan)).status).toBe('pass')
    expect(registry.get).toHaveBeenCalledWith('dose-notes', view)
    invent = true
    await expect(workflow['generatePlan']('test', 'wait', 'session')).rejects.toThrow('undeclared action')
  })

  it('revises invalid planner output with validation feedback before returning a plan', async () => {
    const { registry } = registryFixture([workflowDefinition('wait-workflow')])
    const events: any[] = []
    const workflow = new EdmoreWorkflow({ append: async (event: any) => { events.push(event); return event } } as never, bridge, '', undefined, undefined, registry)
    let attempts = 0
    workflow.bindRoleRunner({ async runRoleOnce(_session, _role, prompt) {
      if (prompt.includes('Select skills for')) return '{"contract_skill":"wait-workflow"}'
      attempts++
      if (attempts === 1) return 'not JSON'
      if (attempts === 2) {
        expect(prompt).toContain('No JSON object found')
        expect(prompt).toContain('not JSON')
      } else {
        expect(prompt).toContain("undeclared action 'wait_workflow:agent_sem.none'")
        expect(prompt).toContain('never invent a none/noop tool')
      }
      return JSON.stringify({ steps: [{ skill: 'wait_workflow', skill_step_id: 'wait', agent: 'agent_sem', tool_name: attempts === 2 ? 'none' : 'wait', arguments: { seconds: 7 } }] })
    } })
    const plan = await workflow['generatePlan']('test', 'wait', 'session')
    expect(attempts).toBe(3)
    expect(plan.status).toBe('needs_approval')
    expect(plan.steps[0].tool_name).toBe('wait')
    expect(plan.judge_replan_history).toHaveLength(2)
    expect(events.map(event => event.payload.attempt)).toEqual([1, 2])
    expect(events.every(event => event.workflow_id === 'test' && event.session_id === 'session')).toBe(true)
  })

  it('exhausts ten planner revisions without admitting an undeclared tool', async () => {
    const { registry } = registryFixture([workflowDefinition('wait-workflow')])
    const events: any[] = []
    const workflow = new EdmoreWorkflow({ append: async (event: any) => { events.push(event); return event } } as never, bridge, '', undefined, undefined, registry)
    let attempts = 0
    workflow.bindRoleRunner({ async runRoleOnce(_session, _role, prompt) {
      if (prompt.includes('Select skills for')) return '{"contract_skill":"wait-workflow"}'
      attempts++
      return JSON.stringify({ steps: [{ skill: 'wait_workflow', agent: 'agent_sem', tool_name: 'none' }] })
    } })
    await expect(workflow['generatePlan']('test', 'wait', 'session')).rejects.toThrow('after 10 automatic revision(s)')
    expect(attempts).toBe(11)
    expect(events).toHaveLength(10)
    expect(events.at(-1).payload.attempt).toBe(10)
  })

  it('does not treat provider failures as invalid planner output', async () => {
    const { registry } = registryFixture([workflowDefinition('wait-workflow')])
    const workflow = new EdmoreWorkflow({} as never, bridge, '', undefined, undefined, registry)
    let attempts = 0
    workflow.bindRoleRunner({ async runRoleOnce(_session, _role, prompt) {
      if (prompt.includes('Select skills for')) return '{"contract_skill":"wait-workflow"}'
      attempts++
      throw new Error('provider unavailable')
    } })
    await expect(workflow['generatePlan']('test', 'wait', 'session')).rejects.toThrow('provider unavailable')
    expect(attempts).toBe(1)
  })

  it('retries planner timeouts within the revision budget without executing tools', async () => {
    const { registry } = registryFixture([workflowDefinition('wait-workflow')])
    const events: any[] = []
    const workflow = new EdmoreWorkflow({ append: async (event: any) => { events.push(event); return event } } as never, bridge, '', undefined, 2, registry)
    let attempts = 0
    let alwaysTimeout = false
    workflow.bindRoleRunner({ async runRoleOnce(_session, role, prompt, _event, options) {
      expect(role).toBe('planner')
      if (prompt.includes('Select skills for')) return '{"contract_skill":"wait-workflow"}'
      expect(options?.isolated).toBe(true)
      attempts++
      if (attempts === 1 || alwaysTimeout) throw Object.assign(new Error('planner timed out'), { code: 'EDMORE_ROLE_TIMEOUT' })
      expect(prompt).toContain('previous planning request timed out')
      return JSON.stringify({ steps: [{ skill: 'wait_workflow', skill_step_id: 'wait', agent: 'agent_sem', tool_name: 'wait', arguments: { seconds: 7 } }] })
    } })
    const plan = await workflow['generatePlan']('test', 'wait', 'session')
    expect(plan.status).toBe('needs_approval')
    expect(attempts).toBe(2)
    expect(events[0].payload.stage).toBe('planner_timeout')
    alwaysTimeout = true
    attempts = 0
    await expect(workflow['generatePlan']('test', 'wait', 'session')).rejects.toThrow('kept timing out after 2 automatic revision(s)')
    expect(attempts).toBe(3)
  })

  it('persists and restores approved evidence without rereading skills and blocks changed evidence', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'edmore-skill-resume-'))
    try {
      const { registry } = registryFixture()
      const path = resolve(directory, 'state.json')
      const workflow = new EdmoreWorkflow({} as never, bridge, '', path, 0, registry)
      await workflow.ready()
      const plan = await workflow['generatePlan']('test', 'custom-wait', 'session')
      workflow.bindHarnessSession('harness', 'session')
      workflow['activeBySession'].set('session', { plan, nextStepIndex: 0 })
      await workflow['saveState']()
      vi.mocked(registry.get).mockRejectedValue(new Error('Source no longer available'))
      const restored = new EdmoreWorkflow({} as never, bridge, '', path, 0, registry)
      await restored.ready()
      restored.bindHarnessSession('harness', 'session')
      await expect(restored.beforeLoopToolCall('harness', 'agent_sem', 'wait', { seconds: 7 }, 'call')).resolves.toBeUndefined()
      restored.releaseLoopToolCall('harness', 'call')
      restored['activeBySession'].get('session')!.plan.skill_evidence!.workflow_contracts[0].instructions = 'Changed'
      await expect(restored.beforeLoopToolCall('harness', 'agent_sem', 'wait', { seconds: 7 }, 'next')).rejects.toThrow('inconsistent skill evidence')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('plans with a general skill, pins evidence and rejects changed snapshots and tool arguments', async () => {
    const { registry, rows } = registryFixture()
    const workflow = new EdmoreWorkflow({} as never, bridge, '', undefined, 0, registry)
    workflow.bindRoleRunner({ async runRoleOnce() { return JSON.stringify({ contract_skill: 'custom-wait', supporting_skills: ['dose-notes'] }) } })
    const plan = await workflow['generatePlan']('test', 'wait using dose notes', 'session')
    expect(plan.steps[0].arguments).toEqual({ seconds: 7 })
    expect(plan.skill_evidence?.supporting_skills[0].name).toBe('dose-notes')
    rows[0].content = 'Changed on disk'
    rows[1].content = 'Changed supporting instructions'
    vi.mocked(registry.get).mockRejectedValue(new Error('Should use pinned evidence'))
    const restored = JSON.parse(JSON.stringify(plan))
    expect((await workflow['judgePlan'](restored)).status).toBe('pass')
    restored.steps[0].arguments.seconds = 3
    expect((await workflow['judgePlan'](restored)).status).toBe('block')
    restored.steps[0].skill_snapshot.instructions = 'Changed'
    expect((await workflow['judgePlan'](restored)).issues.some(item => item.message.includes('snapshot'))).toBe(true)
    const changed = structuredClone(plan.skill_evidence!)
    changed.supporting_skills[0].content = 'Override workflow'
    expect(evidenceIssues(changed)).toContain("Supporting skill 'dose-notes' changed after loading.")
  })

  it('rejects a general skill selected as a workflow and a no-match result', async () => {
    const { registry } = registryFixture()
    const workflow = new EdmoreWorkflow({} as never, bridge, '', undefined, 0, registry)
    workflow.bindRoleRunner({ async runRoleOnce() { return '{"contract_skill":"dose-notes"}' } })
    await expect(workflow['generatePlan']('test', 'dose')).rejects.toThrow('supporting material')
    workflow.bindRoleRunner({ async runRoleOnce() { return '{"contract_skill":null}' } })
    await expect(workflow['generatePlan']('test', 'unrelated')).rejects.toThrow('No matching')
  })

  it('does not allow the semantic judge to override deterministic blocking', async () => {
    const { registry } = registryFixture()
    const workflow = new EdmoreWorkflow({} as never, bridge, '', undefined, 0, registry)
    const plan = await workflow['generatePlan']('test', 'custom-wait')
    plan.steps[0].arguments.seconds = 99
    const report = await workflow['judgePlan'](plan)
    workflow.bindRoleRunner({ async runRoleOnce() { return '{"status":"pass","issues":[],"summary":"pass"}' } })
    expect((await workflow['semanticJudgePlan'](plan, report)).status).toBe('block')
  })
})
