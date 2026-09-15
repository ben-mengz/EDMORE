import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EdmoreWorkflow, type PendingPlan } from '../src/index.ts'

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
  it('accepts the core sequence without optional support tools', async () => {
    const { workflow, plan } = fixture()
    expect((await workflow['judgePlan'](plan)).status).toBe('pass')
    const authority = JSON.parse(await workflow['formatJudgeAuthorityContext'](plan))
    expect(authority.registered_skills[0].optional_tools).toHaveLength(3)
    expect(authority.skill_instructions).toContain('Optional support tools')
    expect(authority.skill_instructions).toContain('After recommendation finishes, resume acquisition')
    expect(authority.supporting_skills.some((s: { skill_id: string }) => s.skill_id === 'recommend_4d_stem_parameters')).toBe(true)
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
    expect(prompt).toContain('A conditional recovery offer is not an executable branch')
    expect(prompt).toContain('requires approval before execution and returns to the saved parent step')
    expect(prompt).toContain('Block any claim to execute an unreviewed branch automatically')
  })
})
