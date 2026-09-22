import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EdmoreWorkflow, type PendingPlan } from './workflow-fixture.ts'

const core = ['prepare_parameters', 'append_exp_params', 'save_params', 'start_server_ptychography']
const optional = ['load_preset', 'search_RAG_for_parameters', 'change_pypty_parameters']
function fixture(names = core) {
  const workflow = new EdmoreWorkflow({
    async append(event) { return { event_id: 'event', cursor: 1, timestamp: new Date().toISOString(), ...event } },
  }, {
    async status() { return { ok: true, agents: ['agent_ptychography'], agentInfo: {}, message: 'ok' } },
    async listTools() { return { tools: [...core, ...optional].map(name => ({ name, inputSchema: { type: 'object' } })) } },
  }, fileURLToPath(new URL('../../../skills', import.meta.url)))
  const plan: PendingPlan = {
    workflow_id: 'test', prompt: 'reconstruct', goal: 'reconstruct', summary: 'reconstruct',
    status: 'needs_approval', user_summary: '', missing_inputs: [], risks: [], judge_replan_history: [],
    judge_report: { status: 'pass', grounding_status: 'fully_grounded', summary: '', issues: [] },
    steps: names.map((tool_name, i) => ({
      step_id: String(i + 1), agent: 'agent_ptychography', skill: 'ptychography', tool_name,
      goal: tool_name, arguments: {}, required_inputs: [], expected_output: 'ok', on_success: 'next', on_failure: 'ask_user',
    })),
  }
  return { workflow, plan }
}

describe('judge skill authority', () => {
  it('deduplicates contracts and identical instruction content without losing safety rules', async () => {
    const { workflow } = fixture()
    const contracts = await workflow['loadSkillContracts']()
    const contract = contracts.get('ptychography')!
    const packet = await workflow['modelSkillPacket']([contract, contract, contract], [{ name: 'reference', provider: 'test', source: 'test', digest: 'test', content: contract.instructions! }])
    expect(Object.keys(packet.skills)).toEqual(['ptychography'])
    expect(Object.values(packet.instructions)).toEqual([contract.instructions])
    expect(packet.supporting_skills[0].authority).toBe('reference_only')
    await expect(workflow['modelSkillPacket']([contract, { ...contract, version: 'conflict' }])).rejects.toThrow('Conflicting')
  })
  it('keeps recommendation planning below the input guard without embedding the parent tree', async () => {
    const { workflow, plan } = fixture()
    const contracts = await workflow['loadSkillContracts']()
    const selected = contracts.get('recommend_4d_stem_parameters')!
    const expanded = workflow['expandSkill'](selected.skill_id, contracts)
    const candidates = workflow['candidateSkillContracts'](selected, expanded, contracts)
    const ancestor = { ...plan, workflow_id: 'ancestor', summary: 'DO_NOT_EMBED_ANCESTOR'.repeat(10000) }
    const parent = { ...plan, workflow_id: 'parent', parent_return: { workflow_id: ancestor.workflow_id, plan: ancestor, next_step_index: 0, reason: 'nested' } }
    const previous = { ...plan, parent_return: { workflow_id: parent.workflow_id, plan: parent, next_step_index: 0, reason: 'missing defocus' } }
    const prompt = await workflow['formatPlannerPrompt']('test', 'Recommend acquisition parameters', selected, expanded, candidates, previous)
    expect(prompt).not.toContain('DO_NOT_EMBED_ANCESTOR')
    expect(prompt).toContain('missing defocus')
    expect(Buffer.byteLength(prompt)).toBeLessThan(96000)
    console.log(`Recommendation planner fixture: ${Buffer.byteLength(prompt)} bytes`)
  })
  it('blocks approval when the semantic model fails instead of passing with a warning', async () => {
    const { workflow, plan } = fixture()
    workflow.bindRoleRunner({ async runRoleOnce() { throw new Error('CONTEXT_WINDOW_EXCEEDED') } })
    const report = await workflow['semanticJudgePlan'](plan, plan.judge_report)
    expect(report.status).toBe('block')
    expect(report.issues.some(issue => issue.severity === 'blocking' && issue.message.includes('CONTEXT_WINDOW_EXCEEDED'))).toBe(true)
  })
  it('passes a compact pending plan and preserves classification errors', async () => {
    const { workflow, plan } = fixture()
    plan.execution_context = [{ event_id: 'large', timestamp: '', source: 'test', type: 'tool.result', workflow_id: 'test', payload: 'NEVER_EMBED_HISTORY'.repeat(5000) }]
    const event = { event_id: 'approve', cursor: 1, timestamp: '', source: 'test', type: 'edmore.trigger.requested', scope: 'workflow', payload: {} }
    workflow.bindRoleRunner({ async runRoleOnce(_session, _role, prompt) {
      expect(prompt).not.toContain('NEVER_EMBED_HISTORY')
      return '{"intent":"approve"}'
    } })
    expect(await workflow['classifyPendingPlanIntent']('approve', event, plan)).toBe('approve')
    workflow.bindRoleRunner({ async runRoleOnce() { throw new Error('CONTEXT_WINDOW_EXCEEDED') } })
    await expect(workflow['classifyPendingPlanIntent']('approve', event, plan)).rejects.toThrow('CONTEXT_WINDOW_EXCEEDED')
  })
  it('accepts the core sequence without optional support tools', async () => {
    const { workflow, plan } = fixture()
    expect((await workflow['judgePlan'](plan)).status).toBe('pass')
    const authority = JSON.parse(await workflow['formatJudgeAuthorityContext'](plan))
    expect(authority.skill_packet.skills[authority.registered_skill_ids[0]].optional_tools).toHaveLength(3)
    const instructions = Object.values(authority.skill_packet.instructions).join('\n')
    expect(instructions).toContain('Optional support tools')
    expect(instructions).toContain('After recommendation finishes, resume acquisition')
    expect(authority.supporting_skill_ids).toContain('recommend_4d_stem_parameters')
  })
  it('allows declared optional tools but still rejects reversed core order and undeclared tools', async () => {
    const supported = fixture(['load_preset', ...core])
    expect((await supported.workflow['judgePlan'](supported.plan)).status).toBe('pass')
    const reversed = fixture([...core].reverse())
    expect((await reversed.workflow['judgePlan'](reversed.plan)).issues.some(i => i.category === 'order')).toBe(true)
    const invalid = fixture(['invented_tool', ...core])
    expect((await invalid.workflow['judgePlan'](invalid.plan)).status).not.toBe('pass')
  })
  it('gives the semantic judge the runtime child-plan approval and return policy', async () => {
    const { workflow, plan } = fixture()
    let prompt = ''
    workflow.bindRoleRunner({ async runRoleOnce(_session, _role, input) {
      prompt = input
      return JSON.stringify({ status: 'pass', summary: 'grounded', issues: [] })
    } })
    await workflow['semanticJudgePlan'](plan, plan.judge_report)
    expect(prompt).toContain('Declared recovery_loops are reviewed conditional branches')
    expect(prompt).toContain('Recovery outside a declared recovery_loop requires a separately reviewed and approved child plan')
    expect(prompt).toContain('Block any claim to execute an unreviewed branch automatically')
  })
  it('keeps PlanReview approval separate from disabled tool-escalation prompts', async () => {
    const { workflow, plan } = fixture()
    let prompt = ''
    workflow.bindRoleRunner({ async runRoleOnce(_session, _role, input) {
      prompt = input
      return JSON.stringify({
        status: 'block',
        summary: 'PlanReview cannot be approved because approval prompts are disabled.',
        issues: [{
          severity: 'blocking', category: 'agent',
          message: 'The workflow PlanReview must be approved by the user before execution. This runtime snapshot has approval prompts disabled, so the plan cannot be executed here.',
        }],
      })
    } })
    const report = await workflow['semanticJudgePlan'](plan, plan.judge_report)
    expect(prompt).toContain('Harness tool-approval policy and EDMORE PlanReview approval are separate mechanisms')
    expect(report.status).toBe('pass')
    expect(report.issues).toEqual([])
  })
})
