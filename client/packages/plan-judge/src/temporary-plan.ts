import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import type { PendingPlan, PlanStep, NionSwiftBridgeLike } from './index.ts'
import { workflowToolSchemaName } from '../../runtime/src/workflow-mcp.ts'

export const temporaryWarning = 'No Workflow Contract. Plan Judge was skipped. Carefully check the target, arguments and effects before approving.'

function validate(schema: Record<string, unknown>, value: unknown): string[] {
  const Constructor = String(schema.$schema ?? '').includes('2020-12') ? Ajv2020 : Ajv
  const ajv = new Constructor({ strict: false, allErrors: true, validateFormats: false })
  const check = ajv.compile(schema)
  return check(value) ? [] : [ajv.errorsText(check.errors)]
}

export function editablePlan(plan: PendingPlan) {
  return { goal: plan.goal, summary: plan.summary, steps: plan.steps.map(step => ({
    agent: step.agent, tool_name: step.tool_name, goal: step.goal, arguments: step.arguments,
    success_criterion: step.completion?.criteria ?? '',
  })) }
}

export async function temporaryPlan(raw: unknown, base: { workflow_id: string; session_id?: string; prompt: string }, bridge: NionSwiftBridgeLike): Promise<PendingPlan> {
  const draftSchema = { type: 'object', additionalProperties: false, required: ['goal', 'summary', 'steps'], properties: {
    goal: { type: 'string', minLength: 1 }, summary: { type: 'string' },
    steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false,
      required: ['agent', 'tool_name', 'goal', 'arguments', 'success_criterion'], properties: {
        agent: { type: 'string', minLength: 1 }, tool_name: { type: 'string', minLength: 1 },
        goal: { type: 'string', minLength: 1 }, arguments: { type: 'object' }, success_criterion: { type: 'string', minLength: 1 },
      } } },
  } }
  const errors = validate(draftSchema, raw)
  if (errors.length) throw new Error(`Invalid plan JSON: ${errors.join('; ')}`)
  const draft = raw as ReturnType<typeof editablePlan>
  const status = await bridge.status()
  const steps: PlanStep[] = []
  for (const [i, step] of draft.steps.entries()) {
    if (!status.ok || !status.agents.includes(step.agent)) throw new Error(`Unavailable agent: ${step.agent}`)
    const listing = await bridge.listTools(step.agent) as { tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }> }
    const tool = listing.tools?.find(item => item.name === workflowToolSchemaName(step.agent, step.tool_name))
    if (!tool?.inputSchema) throw new Error(`Tool/schema unavailable: ${step.agent}.${step.tool_name}`)
    const violations = validate(tool.inputSchema, step.arguments)
    if (violations.length) throw new Error(`Step ${i + 1}: ${violations.join('; ')}`)
    steps.push({ step_id: String(i + 1), skill: '', agent: step.agent, tool_name: step.tool_name,
      goal: step.goal, arguments: structuredClone(step.arguments), required_inputs: [],
      expected_output: step.success_criterion, completion: { type: 'semantic_judge', criteria: step.success_criterion },
      on_success: i === draft.steps.length - 1 ? 'complete' : 'next', on_failure: 'pause', on_error: 'pause', max_visits: 1 })
  }
  return { ...base, planning_mode: 'temporary', status: 'needs_approval', goal: draft.goal, summary: draft.summary,
    user_summary: temporaryWarning, missing_inputs: [], risks: [temporaryWarning], steps, judge_replan_history: [],
    judge_report: { status: 'pass', grounding_status: 'ungrounded', summary: 'Schema validation only; semantic Plan Judge skipped.', issues: [
      { severity: 'warning', category: 'grounding', message: temporaryWarning },
    ] } }
}
