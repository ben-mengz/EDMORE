import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export const name = 'edmore-plan-judge'

export interface EdmoreEvent {
  event_id: string
  cursor: number
  timestamp: string
  source: string
  type: string
  scope: string
  session_id?: string
  workflow_id?: string
  server_id?: string
  correlation_id?: string
  payload: unknown
}

export interface EdmoreEventHubLike {
  append(event: Omit<EdmoreEvent, 'event_id' | 'cursor' | 'timestamp'>): Promise<EdmoreEvent>
}

export interface NionSwiftBridgeLike {
  status(): Promise<{ ok: boolean; agents: string[]; agentInfo: Record<string, { name: string; provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number }>; message: string }>
  listTools(agent: string): Promise<unknown>
}

export interface EdmoreRoleRunner {
  runRoleOnce(sessionId: string, role: string, prompt: string, event: EdmoreEvent, options?: RoleRunOptions): Promise<string>
}

export interface EdmorePlanJudgeService {
  createWorkflow(hub: EdmoreEventHubLike, nionSwift: NionSwiftBridgeLike, skillsRoot: string, stateStorePath?: string, autoRepairMaxAttempts?: number): EdmoreWorkflow
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    edmorePlanJudge: EdmorePlanJudgeService
  }
}

export function apply(ctx: Context): void {
  ctx.provide('edmorePlanJudge', {
    createWorkflow(hub, nionSwift, skillsRoot, stateStorePath, autoRepairMaxAttempts) {
      return new EdmoreWorkflow(hub, nionSwift, skillsRoot, stateStorePath, autoRepairMaxAttempts)
    },
  })
}

export interface PlanStep {
  step_id: string
  agent: string
  goal: string
  skill: string
  tool_name: string
  arguments: Record<string, unknown>
  required_inputs: string[]
  expected_output: string
  on_success: string
  on_failure: string
}

export interface PendingPlan {
  workflow_id: string
  session_id?: string
  parent_return?: ParentPlanReturn
  prompt: string
  status: 'needs_approval'
  goal: string
  summary: string
  steps: PlanStep[]
  user_summary: string
  missing_inputs: string[]
  risks: string[]
  judge_report: PlanJudgeReport
  judge_replan_history: string[]
}

interface ParentPlanReturn {
  workflow_id: string
  session_id?: string
  plan: PendingPlan
  next_step_index: number
  reason: string
}

interface RuntimeSubplanProposal {
  subplan_goal: string
  user_message: string
  reason: string
}

interface PlanningProposal {
  proposal_id: string
  session_id?: string
  prompt: string
  plan_goal: string
  user_message: string
  reason: string
}

interface PausedWorkflowState {
  plan: PendingPlan
  reason: string
  state: Record<string, unknown>
  recovery_proposal?: RuntimeSubplanProposal
  parent_return?: ParentPlanReturn
}

interface PlanJudgeIssue {
  severity: 'info' | 'warning' | 'blocking'
  category: 'grounding' | 'skill' | 'order' | 'agent' | 'tool' | 'parameter'
  step_id?: string
  skill?: string
  message: string
}

interface PlanJudgeReport {
  grounding_status: 'fully_grounded' | 'partially_grounded' | 'ungrounded'
  status: 'pass' | 'revise' | 'block'
  summary: string
  issues: PlanJudgeIssue[]
}

interface SkillContract {
  skill_id: string
  name: string
  agents: string[]
  required_tools: string[]
  optional_tools: string[]
  ordered_tools: string[]
  references: string[]
}

export interface WorkflowRoute {
  action: 'chat' | 'planned' | 'blocked' | 'execute'
  message?: string
  plan?: PendingPlan
  executionPrompt?: string
  workflowId?: string
  role?: string
}

interface ActiveWorkflowState {
  plan: PendingPlan
  nextStepIndex: number
  confirmedStepIndex?: number
}

interface InFlightToolCall {
  workflowId: string
  stepIndex: number
  stepId: string
  callId: string
}

interface InstrumentLease {
  instrument_id: string
  session_id: string
  workflow_id: string
  state: 'active' | 'paused' | 'in_flight' | 'verify_required'
  reason: string
}

interface WorkflowStateSnapshot {
  version: 1
  planningProposals: PlanningProposal[]
  planningProposalBySession: [string, string][]
  pending: PendingPlan[]
  pendingBySession: [string, string][]
  activeBySession: Array<[string, ActiveWorkflowState]>
  pausedBySession: Array<[string, PausedWorkflowState]>
  inFlightToolCalls: Array<[string, InFlightToolCall]>
  instrumentLeases: Array<[string, InstrumentLease]>
  archived: PendingPlan[]
}

export interface LoopDispatch {
  workflowId: string
  prompt: string
  role: string
  step: PlanStep
}

export interface RoleRunOptions {
  hidden?: boolean
  source?: string
}

type PendingPlanIntent = 'approve' | 'reject' | 'revise' | 'new_query' | 'question' | 'wait'
type PausedWorkflowIntent = 'resume' | 'subplan' | 'reject' | 'revise' | 'question' | 'wait'
type PlanningProposalIntent = 'approve' | 'reject' | 'revise' | 'new_query' | 'question' | 'wait'

function parseJsonObjectFromText(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  try {
    return asRecord(JSON.parse(candidate))
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('No JSON object found in agent output')
    return asRecord(JSON.parse(candidate.slice(start, end + 1)))
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function executorRoleForMcpAgent(agent: string): string {
  return `executor:${agent}`
}

function mergeUnique(values: string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    output.push(trimmed)
  }
  return output
}

function normalizeJudgeStatus(value: unknown): PlanJudgeReport['status'] {
  return value === 'pass' || value === 'revise' || value === 'block' ? value : 'block'
}

function normalizeJudgeIssue(value: unknown): PlanJudgeIssue | undefined {
  const raw = asRecord(value)
  const message = optionalString(raw.message)
  if (message === undefined) return undefined
  const severity = raw.severity === 'info' || raw.severity === 'warning' || raw.severity === 'blocking'
    ? raw.severity
    : 'warning'
  const category = raw.category === 'grounding'
    || raw.category === 'skill'
    || raw.category === 'order'
    || raw.category === 'agent'
    || raw.category === 'tool'
    || raw.category === 'parameter'
    ? raw.category
    : 'grounding'
  const stepId = optionalString(raw.step_id)
  const skill = optionalString(raw.skill)
  return {
    severity,
    category,
    ...stepId === undefined ? {} : { step_id: stepId },
    ...skill === undefined ? {} : { skill },
    message,
  }
}

function semanticIssueIsCoveredByPlan(issue: PlanJudgeIssue, plan: PendingPlan): boolean {
  const message = issue.message.toLowerCase()
  const step = issue.step_id === undefined
    ? undefined
    : plan.steps.find(candidate => candidate.step_id === issue.step_id)
  const requiredInputs = step?.required_inputs.join('\n').toLowerCase() ?? ''
  if ((issue.category === 'skill' || issue.category === 'grounding')
    && /non-registered skill|not registered|registered skill|skill identifier|skill id|mismatch/.test(message)) {
    return true
  }
  if (step !== undefined && /approval|confirm|confirmation|gate|批准|确认/.test(message)) {
    return /confirm|approval|批准|确认/.test(requiredInputs)
  }
  if (step === undefined && /approval|confirm|confirmation|gate|批准|确认/.test(message)) {
    return plan.steps.some(candidate => /confirm|approval|批准|确认/.test(candidate.required_inputs.join('\n').toLowerCase()))
  }
  if (step !== undefined && issue.category === 'parameter') {
    const quotedNames = [...message.matchAll(/['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/g)]
      .map(match => match[1])
      .filter((name): name is string => name !== undefined)
    if (/unknown|unexpected|misspelled|not recognized|invalid parameter|wrong parameter/.test(message)
      && quotedNames.length > 0
      && quotedNames.every(name => Object.hasOwn(step.arguments, name))) {
      return true
    }
    const names = ['defocus_a', 'dwell_time_us', 'scan_step_x_a', 'scan_points_x', 'scan_step_y_a', 'scan_points_y']
    const mentioned = names.filter(name => message.includes(name.toLowerCase()))
    if (mentioned.length === 0) return false
    return mentioned.every(name => requiredInputs.includes(name.toLowerCase()))
  }
  if (issue.category === 'grounding' && message.includes('deterministic judge reported') && message.includes('pass')) {
    return true
  }
  return false
}

function sanitizeSemanticJudgeReport(
  plan: PendingPlan,
  deterministicReport: PlanJudgeReport,
  judgeStatus: PlanJudgeReport['status'],
  summary: string,
  semanticIssues: PlanJudgeIssue[],
): PlanJudgeReport {
  if (deterministicReport.status !== 'pass') {
    return {
      grounding_status: deterministicReport.grounding_status,
      status: deterministicReport.status,
      summary: deterministicReport.summary || summary,
      issues: [
        ...deterministicReport.issues,
        ...semanticIssues.map(issue => ({
          ...issue,
          severity: issue.severity === 'blocking' ? 'warning' as const : issue.severity,
        })),
      ],
    }
  }
  const actionableIssues = semanticIssues.filter(issue => !semanticIssueIsCoveredByPlan(issue, plan))
  const sanitizedStatus = actionableIssues.some(issue => issue.severity === 'blocking')
    ? judgeStatus
    : 'pass'
  return {
    grounding_status: deterministicReport.grounding_status,
    status: sanitizedStatus,
    summary: actionableIssues.length === semanticIssues.length
      ? summary
      : sanitizedStatus === 'pass'
        ? 'Deterministic gates passed; semantic judge concerns are covered by required user inputs or approval gates.'
        : summary,
    issues: [
      ...deterministicReport.issues,
      ...actionableIssues,
    ],
  }
}

export class EdmoreWorkflow {
  private planningProposals = new Map<string, PlanningProposal>()
  private planningProposalBySession = new Map<string, string>()
  private pending = new Map<string, PendingPlan>()
  private pendingBySession = new Map<string, string>()
  private activeBySession = new Map<string, ActiveWorkflowState>()
  private sessionByHarnessAgent = new Map<string, string>()
  private pausedBySession = new Map<string, PausedWorkflowState>()
  private inFlightToolCalls = new Map<string, InFlightToolCall>()
  private instrumentLeases = new Map<string, InstrumentLease>()
  private archived: PendingPlan[] = []
  private handledTriggers = new Set<string>()
  private roleRunner?: EdmoreRoleRunner
  private readonly hydration: Promise<void>

  constructor(
    private hub: EdmoreEventHubLike,
    private nionSwift: NionSwiftBridgeLike,
    private skillsRoot: string,
    private stateStorePath?: string,
    private autoRepairMaxAttempts = 2,
  ) {
    this.hydration = this.loadState()
  }

  async ready(): Promise<void> {
    await this.hydration
  }

  private async ensureHydrated(): Promise<void> {
    await this.hydration
  }

  private async loadState(): Promise<void> {
    if (this.stateStorePath === undefined) return
    let rawText: string
    try {
      rawText = await readFile(this.stateStorePath, 'utf8')
    } catch (error) {
      if (asRecord(error).code === 'ENOENT') return
      throw error
    }
    const raw = asRecord(JSON.parse(rawText))
    if (raw.version !== 1) return
    this.planningProposals = new Map(arrayOfRecords(raw.planningProposals).map(proposal => [stringOr(proposal.proposal_id, randomUUID()), proposal as unknown as PlanningProposal]))
    this.planningProposalBySession = new Map(Array.isArray(raw.planningProposalBySession)
      ? raw.planningProposalBySession.map((entry): [string, string] => [String(asArray(entry)[0] ?? ''), String(asArray(entry)[1] ?? '')]).filter(([key, value]) => key.length > 0 && value.length > 0)
      : [])
    this.pending = new Map(arrayOfRecords(raw.pending).map(plan => [stringOr(plan.workflow_id, randomUUID()), plan as unknown as PendingPlan]))
    this.pendingBySession = new Map(Array.isArray(raw.pendingBySession)
      ? raw.pendingBySession.map((entry): [string, string] => [String(asArray(entry)[0] ?? ''), String(asArray(entry)[1] ?? '')]).filter(([key, value]) => key.length > 0 && value.length > 0)
      : [])
    this.activeBySession = new Map(Array.isArray(raw.activeBySession)
      ? raw.activeBySession.map((entry): [string, ActiveWorkflowState] | undefined => {
        const pair = asArray(entry)
        const key = typeof pair[0] === 'string' ? pair[0] : undefined
        const value = asRecord(pair[1])
        const plan = asRecord(value.plan) as unknown as PendingPlan
        if (key === undefined || typeof plan.workflow_id !== 'string') return undefined
        return [key, {
          plan,
          nextStepIndex: numberOr(value.nextStepIndex, 0),
          ...typeof value.confirmedStepIndex === 'number' ? { confirmedStepIndex: value.confirmedStepIndex } : {},
        }]
      }).filter((entry): entry is [string, ActiveWorkflowState] => entry !== undefined)
      : [])
    this.pausedBySession = new Map(Array.isArray(raw.pausedBySession)
      ? raw.pausedBySession.map((entry): [string, PausedWorkflowState] | undefined => {
        const pair = asArray(entry)
        const key = typeof pair[0] === 'string' ? pair[0] : undefined
        const value = asRecord(pair[1])
        const plan = asRecord(value.plan) as unknown as PendingPlan
        const reason = optionalString(value.reason)
        if (key === undefined || typeof plan.workflow_id !== 'string' || reason === undefined) return undefined
        return [key, {
          plan,
          reason,
          state: asRecord(value.state),
          ...asRecord(value.recovery_proposal).subplan_goal === undefined ? {} : { recovery_proposal: asRecord(value.recovery_proposal) as unknown as RuntimeSubplanProposal },
          ...asRecord(value.parent_return).workflow_id === undefined ? {} : { parent_return: asRecord(value.parent_return) as unknown as ParentPlanReturn },
        }]
      }).filter((entry): entry is [string, PausedWorkflowState] => entry !== undefined)
      : [])
    this.inFlightToolCalls = new Map(Array.isArray(raw.inFlightToolCalls)
      ? raw.inFlightToolCalls.map((entry): [string, InFlightToolCall] | undefined => {
        const pair = asArray(entry)
        const key = typeof pair[0] === 'string' ? pair[0] : undefined
        const value = asRecord(pair[1])
        const callId = optionalString(value.callId)
        const workflowId = optionalString(value.workflowId)
        const stepId = optionalString(value.stepId)
        if (key === undefined || callId === undefined || workflowId === undefined || stepId === undefined) return undefined
        return [key, {
          workflowId,
          stepIndex: numberOr(value.stepIndex, 0),
          stepId,
          callId,
        }]
      }).filter((entry): entry is [string, InFlightToolCall] => entry !== undefined)
      : [])
    this.instrumentLeases = new Map(Array.isArray(raw.instrumentLeases)
      ? raw.instrumentLeases.map((entry): [string, InstrumentLease] | undefined => {
        const pair = asArray(entry)
        const key = typeof pair[0] === 'string' ? pair[0] : undefined
        const value = asRecord(pair[1])
        const instrumentId = optionalString(value.instrument_id)
        const sessionId = optionalString(value.session_id)
        const workflowId = optionalString(value.workflow_id)
        if (key === undefined || instrumentId === undefined || sessionId === undefined || workflowId === undefined) return undefined
        return [key, {
          instrument_id: instrumentId,
          session_id: sessionId,
          workflow_id: workflowId,
          state: value.state === 'paused' || value.state === 'in_flight' || value.state === 'verify_required' ? value.state : 'active',
          reason: optionalString(value.reason) ?? 'Restored instrument lease.',
        }]
      }).filter((entry): entry is [string, InstrumentLease] => entry !== undefined)
      : [])
    this.archived = arrayOfRecords(raw.archived) as unknown as PendingPlan[]
    for (const [sessionId, inFlight] of this.inFlightToolCalls) {
      const active = this.activeBySession.get(sessionId)
      const step = active?.plan.steps[inFlight.stepIndex]
      if (active === undefined || step === undefined) continue
      const reason = [
        `Backend restarted while step ${step.step_id} was in flight: ${step.goal}`,
        '',
        'The tool result must be verified before continuing. Query the instrument status or confirm the actual result, then resume.',
      ].join('\n')
      this.activeBySession.delete(sessionId)
      this.pausedBySession.set(sessionId, {
        plan: active.plan,
        reason,
        state: {
          step_id: step.step_id,
          agent: step.agent,
          tool_name: step.tool_name,
          next_step_index: inFlight.stepIndex,
          required_inputs: [
            'verify_in_flight_tool_result_after_backend_restart',
            'confirm whether the in-flight tool completed successfully before resuming',
          ],
          previous_call_id: inFlight.callId,
          restart_recovery: true,
        },
      })
      this.updateInstrumentLeases(sessionId, active.plan, 'verify_required', reason)
    }
    this.inFlightToolCalls.clear()
  }

  private async saveState(): Promise<void> {
    await this.hydration
    if (this.stateStorePath === undefined) return
    const snapshot: WorkflowStateSnapshot = {
      version: 1,
      planningProposals: [...this.planningProposals.values()],
      planningProposalBySession: [...this.planningProposalBySession.entries()],
      pending: [...this.pending.values()],
      pendingBySession: [...this.pendingBySession.entries()],
      activeBySession: [...this.activeBySession.entries()],
      pausedBySession: [...this.pausedBySession.entries()],
      inFlightToolCalls: [...this.inFlightToolCalls.entries()],
      instrumentLeases: [...this.instrumentLeases.entries()],
      archived: this.archived.slice(-100),
    }
    await mkdir(dirname(this.stateStorePath), { recursive: true })
    const temporary = `${this.stateStorePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8')
    await rename(temporary, this.stateStorePath)
  }

  bindRoleRunner(roleRunner: EdmoreRoleRunner): void {
    this.roleRunner = roleRunner
  }

  state(): unknown {
    return {
      planning_proposals: [...this.planningProposals.values()],
      pending: [...this.pending.values()],
      active: [...this.activeBySession.entries()].map(([session_id, value]) => ({
        session_id,
        workflow_id: value.plan.workflow_id,
        next_step_index: value.nextStepIndex,
        next_step: value.plan.steps[value.nextStepIndex],
      })),
      paused: [...this.pausedBySession.entries()].map(([session_id, value]) => ({
        session_id,
        workflow_id: value.plan.workflow_id,
        reason: value.reason,
        state: value.state,
        ...value.recovery_proposal === undefined ? {} : { recovery_proposal: value.recovery_proposal },
      })),
      instrument_leases: [...this.instrumentLeases.values()],
      archived_count: this.archived.length,
    }
  }

  bindHarnessSession(harnessSessionId: string, sessionId: string): void {
    this.sessionByHarnessAgent.set(harnessSessionId, sessionId)
  }

  private assertInstrumentAvailable(plan: PendingPlan, sessionId: string, workflowId: string): void {
    for (const instrumentId of instrumentIdsForPlan(plan)) {
      const lease = this.instrumentLeases.get(instrumentId)
      if (lease !== undefined && (lease.session_id !== sessionId || lease.workflow_id !== workflowId)) {
        throw new Error(`Instrument ${instrumentId} is currently occupied by workflow ${lease.workflow_id} in session ${lease.session_id}: ${lease.reason}`)
      }
    }
  }

  private updateInstrumentLeases(sessionId: string, plan: PendingPlan, state: InstrumentLease['state'], reason: string): void {
    for (const instrumentId of instrumentIdsForPlan(plan)) {
      this.instrumentLeases.set(instrumentId, {
        instrument_id: instrumentId,
        session_id: sessionId,
        workflow_id: plan.workflow_id,
        state,
        reason,
      })
    }
  }

  private releaseInstrumentLeases(sessionId: string, workflowId: string): void {
    for (const [instrumentId, lease] of this.instrumentLeases) {
      if (lease.session_id === sessionId && lease.workflow_id === workflowId) {
        this.instrumentLeases.delete(instrumentId)
      }
    }
  }

  routeSessionForLegacyTrigger(event: EdmoreEvent): string | undefined {
    if (event.session_id !== undefined) return event.session_id
    if (!isLegacyWorkflowConfirmation(event)) return undefined
    if (this.pausedBySession.size !== 1) return undefined
    return [...this.pausedBySession.keys()][0]
  }

  async trigger(prompt: string, sessionId?: string, payload: Record<string, unknown> = {}): Promise<EdmoreEvent> {
    return await this.hub.append(withOptionalSession({
      type: 'edmore.trigger.requested',
      source: 'edmore-client-api',
      scope: 'workflow',
      payload: { ...payload, prompt },
    }, sessionId))
  }

  async handleTrigger(event: EdmoreEvent): Promise<WorkflowRoute> {
    await this.ensureHydrated()
    if (this.handledTriggers.has(event.event_id)) return { action: 'blocked', message: 'Duplicate trigger ignored.' }
    this.handledTriggers.add(event.event_id)
    const payload = event.payload as { prompt?: unknown; confirmation_context?: unknown } | undefined
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
    if (!prompt) return { action: 'blocked', message: 'Empty trigger ignored.' }
    const sessionId = event.session_id ?? 'default'

    const paused = this.pausedBySession.get(sessionId)
    if (paused !== undefined) {
      if (paused.recovery_proposal !== undefined && paused.parent_return !== undefined) {
        const decision = await this.classifyRuntimeProposalIntent(prompt, event, paused)
        if (decision === 'resume') {
          return await this.resumePausedWorkflow(paused, sessionId, event.session_id, prompt, event.event_id, payload?.confirmation_context)
        }
        if (decision === 'approve') {
          this.pausedBySession.delete(sessionId)
          await this.saveState()
          await this.hub.append(withOptionalSession({
            type: 'edmore.custom.subplan.accepted',
            source: 'edmore-runtime-subplan',
            scope: 'workflow',
            workflow_id: paused.plan.workflow_id,
            correlation_id: event.event_id,
            payload: {
              subplan_goal: paused.recovery_proposal.subplan_goal,
              reason: paused.recovery_proposal.reason,
            },
          }, event.session_id))
          return await this.createAndQueuePlan(paused.recovery_proposal.subplan_goal, event, undefined, paused.parent_return)
        }
        if (decision === 'reject') {
          this.pausedBySession.set(sessionId, {
            plan: paused.plan,
            reason: paused.reason,
            state: paused.state,
          })
          await this.saveState()
          const message = [
            'The parent workflow remains paused.',
            '',
            paused.reason,
            '',
            'Tell me how to proceed, or describe another recovery direction.',
          ].join('\n')
          await this.emitAssistantMessage(event, message)
          return { action: 'blocked', message, plan: paused.plan }
        }
        if (decision === 'revise') {
          const revised = await this.reviseRuntimeSubplanProposal(prompt, event, paused)
          if (revised !== undefined) {
            this.pausedBySession.set(sessionId, {
              ...paused,
              recovery_proposal: revised,
            })
            await this.saveState()
            await this.hub.append(withOptionalSession({
              type: 'edmore.custom.subplan.proposed',
              source: 'edmore-runtime-subplan',
              scope: 'workflow',
              workflow_id: paused.plan.workflow_id,
              correlation_id: event.event_id,
              payload: {
                ...revised,
                awaits_user_approval_to_plan: true,
                revised: true,
              },
            }, event.session_id))
            await this.emitAssistantMessage(event, this.formatRuntimeSubplanProposal(paused, revised))
            return { action: 'blocked', message: 'Runtime recovery idea revised.', plan: paused.plan }
          }
        }
        if (decision === 'question') {
          await this.answerRuntimeSubplanQuestion(prompt, event, paused)
          return { action: 'blocked', message: 'Answered runtime recovery question.', plan: paused.plan }
        }
        const message = [
          paused.recovery_proposal.user_message,
          '',
          "Reply 'approve' to let me create and judge a child plan from this idea, or tell me how to change the idea first.",
        ].join('\n')
        await this.emitAssistantMessage(event, message)
        return { action: 'blocked', message, plan: paused.plan }
      }
      const decision = await this.classifyPausedWorkflowIntent(prompt, event, paused)
      if (decision === 'resume') {
        return await this.resumePausedWorkflow(paused, sessionId, event.session_id, prompt, event.event_id, payload?.confirmation_context)
      }
      if (decision === 'subplan' || decision === 'revise') {
        const proposal = await this.proposeRuntimeSubplan(paused.plan, stepFromPausedState(paused.state), numberOr(paused.state.next_step_index, 0), paused.reason, sessionId, event.event_id, prompt)
        if (proposal !== undefined) {
          const parentReturn: ParentPlanReturn = {
            workflow_id: paused.plan.workflow_id,
            ...paused.plan.session_id === undefined ? {} : { session_id: paused.plan.session_id },
            plan: paused.plan,
            next_step_index: numberOr(paused.state.next_step_index, 0),
            reason: paused.reason,
          }
          this.pausedBySession.set(sessionId, {
            ...paused,
            recovery_proposal: proposal,
            parent_return: parentReturn,
          })
          await this.saveState()
          await this.hub.append(withOptionalSession({
            type: 'edmore.custom.subplan.proposed',
            source: 'edmore-runtime-subplan',
            scope: 'workflow',
            workflow_id: paused.plan.workflow_id,
            correlation_id: event.event_id,
            payload: {
              ...proposal,
              awaits_user_approval_to_plan: true,
            },
          }, event.session_id))
          await this.emitAssistantMessage(event, this.formatRuntimeSubplanProposal({
            ...paused,
            recovery_proposal: proposal,
            parent_return: parentReturn,
          }, proposal))
          return { action: 'blocked', message: 'Runtime recovery idea proposed.', plan: paused.plan }
        }
      }
      if (decision === 'question') {
        await this.answerPausedWorkflowQuestion(prompt, event, paused)
        return { action: 'blocked', message: 'Answered paused workflow question.', plan: paused.plan }
      }
      if (decision === 'reject') {
        this.pausedBySession.delete(sessionId)
        this.releaseInstrumentLeases(sessionId, paused.plan.workflow_id)
        await this.saveState()
        await this.hub.append(withOptionalSession({
          type: 'edmore.workflow.failed',
          source: 'edmore-plan-judge',
          scope: 'workflow',
          workflow_id: paused.plan.workflow_id,
          correlation_id: event.event_id,
          payload: { reason: prompt || 'Paused workflow rejected by user.' },
        }, event.session_id))
        const message = 'Paused workflow cancelled.'
        await this.emitAssistantMessage(event, message)
        return { action: 'blocked', message, plan: paused.plan }
      }
      if (decision === 'wait') {
        await this.emitAssistantMessage(event, paused.reason)
        return { action: 'blocked', message: paused.reason }
      }
      await this.emitAssistantMessage(event, paused.reason)
      return { action: 'blocked', message: paused.reason }
    }

    const planningProposalId = this.planningProposalBySession.get(sessionId)
    if (planningProposalId !== undefined) {
      const proposal = this.planningProposals.get(planningProposalId)
      if (proposal !== undefined) {
        const decision = await this.classifyPlanningProposalIntent(prompt, event, proposal)
        if (decision === 'approve') {
          this.planningProposals.delete(planningProposalId)
          this.planningProposalBySession.delete(sessionId)
          await this.saveState()
          await this.hub.append(withOptionalSession({
            type: 'edmore.custom.planning_proposal.accepted',
            source: 'edmore-plan-judge',
            scope: 'workflow',
            correlation_id: event.event_id,
            payload: {
              proposal_id: proposal.proposal_id,
              plan_goal: proposal.plan_goal,
              reason: proposal.reason,
            },
          }, event.session_id))
          return await this.createAndQueuePlan(proposal.plan_goal, event)
        }
        if (decision === 'reject') {
          this.planningProposals.delete(planningProposalId)
          this.planningProposalBySession.delete(sessionId)
          await this.saveState()
          const message = 'Planning direction rejected. No PlanReview was created.'
          await this.hub.append(withOptionalSession({
            type: 'edmore.custom.planning_proposal.rejected',
            source: 'edmore-plan-judge',
            scope: 'workflow',
            correlation_id: event.event_id,
            payload: { proposal_id: proposal.proposal_id, reason: prompt },
          }, event.session_id))
          await this.emitAssistantMessage(event, message)
          return { action: 'blocked', message }
        }
        if (decision === 'revise') {
          return await this.createPlanningProposal(prompt, event, proposal)
        }
        if (decision === 'new_query') {
          this.planningProposals.delete(planningProposalId)
          this.planningProposalBySession.delete(sessionId)
          await this.saveState()
        } else if (decision === 'question') {
          await this.answerPlanningProposalQuestion(prompt, event, proposal)
          return { action: 'blocked', message: 'Answered planning proposal question.' }
        } else {
          await this.emitAssistantMessage(event, this.formatPlanningProposal(proposal))
          return { action: 'blocked', message: 'Planning direction is waiting for user approval.' }
        }
      } else {
        this.planningProposalBySession.delete(sessionId)
        await this.saveState()
      }
    }

    const pendingWorkflowId = this.pendingBySession.get(sessionId)
    if (pendingWorkflowId !== undefined) {
      const pending = this.pending.get(pendingWorkflowId)
      if (pending !== undefined) {
        const decision = await this.classifyPendingPlanIntent(prompt, event, pending)
        if (decision === 'approve') {
          return await this.approve(pendingWorkflowId, event.session_id, event.event_id)
        }
        if (decision === 'reject') {
          await this.reject(pendingWorkflowId, prompt, event.session_id)
          return { action: 'blocked', message: 'Pending plan rejected.' }
        }
        if (decision === 'revise') {
          return await this.createAndQueuePlan(prompt, event, pending)
        }
        if (decision === 'new_query') {
          await this.reject(pendingWorkflowId, 'Superseded by a new user query.', event.session_id)
        } else if (decision === 'question') {
          await this.answerPendingPlanQuestion(prompt, event, pending)
          return { action: 'blocked', message: 'Answered pending plan question.', plan: pending }
        } else {
          const message = "A plan is waiting for approval, but the intent agent could not classify your last message. Please state whether you want to approve, reject, revise, ask about this plan, or start a new query."
          await this.emitAssistantMessage(event, message)
          return { action: 'blocked', message, plan: pending }
        }
      }
      this.pendingBySession.delete(sessionId)
      await this.saveState()
    }

    let needsPlan: boolean
    try {
      needsPlan = await this.shouldPlan(prompt, event)
    } catch (error) {
      const message = `Planning router failed: ${error instanceof Error ? error.message : String(error)}`
      await this.emitAssistantMessage(event, message)
      return { action: 'blocked', message }
    }
    if (!needsPlan) return { action: 'chat' }
    return await this.createPlanningProposal(prompt, event)
  }

  async approve(workflowId: string, sessionId?: string, correlationId?: string): Promise<WorkflowRoute> {
    await this.ensureHydrated()
    const plan = this.pending.get(workflowId)
    if (plan === undefined) {
      const active = [...this.activeBySession.values()].find(value => value.plan.workflow_id === workflowId)
      if (active !== undefined) return { action: 'blocked', workflowId, message: 'Workflow is already approved or running.', plan: active.plan }
      throw new Error(`pending plan not found: ${workflowId}`)
    }
    const sessionKey = sessionId ?? plan.session_id ?? 'default'
    this.assertInstrumentAvailable(plan, sessionKey, workflowId)
    this.pending.delete(workflowId)
    this.pendingBySession.delete(sessionKey)
    await this.hub.append(withOptionalSession({
      type: 'edmore.approval.granted',
      source: 'edmore-client-api',
      scope: 'workflow',
      workflow_id: workflowId,
      ...correlationId === undefined ? {} : { correlation_id: correlationId },
      payload: {},
    }, sessionId))
    await this.hub.append(withOptionalSession({
      type: 'edmore.workflow.started',
      source: 'edmore-plan-judge',
      scope: 'workflow',
      workflow_id: workflowId,
      ...correlationId === undefined ? {} : { correlation_id: correlationId },
      payload: { steps: plan.steps },
    }, sessionId))
    this.activeBySession.set(sessionKey, { plan, nextStepIndex: 0 })
    this.updateInstrumentLeases(sessionKey, plan, 'active', 'Approved workflow is active.')
    await this.saveState()
    const dispatch = this.nextLoopDispatch(sessionKey, plan.workflow_id)
    if (dispatch === undefined) return { action: 'blocked', message: 'Approved plan has no executable step.', plan }
    return {
      action: 'execute',
      workflowId: plan.workflow_id,
      executionPrompt: dispatch.prompt,
      role: dispatch.role,
      plan,
    }
  }

  async resume(workflowId: string | undefined, sessionId: string | undefined, prompt = 'confirm', correlationId?: string, confirmationContext?: unknown): Promise<WorkflowRoute> {
    await this.ensureHydrated()
    const sessionKey = sessionId ?? 'default'
    const paused = this.pausedBySession.get(sessionKey)
    if (paused === undefined) throw new Error(`paused workflow not found for session: ${sessionKey}`)
    if (workflowId !== undefined && paused.plan.workflow_id !== workflowId) {
      throw new Error(`paused workflow mismatch: expected ${paused.plan.workflow_id}, got ${workflowId}`)
    }
    this.assertInstrumentAvailable(paused.plan, sessionKey, paused.plan.workflow_id)
    return await this.resumePausedWorkflow(paused, sessionKey, sessionId, prompt, correlationId, confirmationContext)
  }

  async reject(workflowId: string, reason?: string, sessionId?: string): Promise<void> {
    await this.ensureHydrated()
    const plan = this.pending.get(workflowId)
    this.pending.delete(workflowId)
    this.pendingBySession.delete(sessionId ?? plan?.session_id ?? 'default')
    if (plan !== undefined) this.archived.push(plan)
    await this.saveState()
    await this.hub.append(withOptionalSession({ type: 'edmore.approval.rejected', source: 'edmore-client-api', scope: 'workflow', workflow_id: workflowId, payload: { reason } }, sessionId))
  }

  private async resumePausedWorkflow(
    paused: PausedWorkflowState,
    sessionKey: string,
    eventSessionId: string | undefined,
    prompt: string,
    correlationId: string | undefined,
    confirmationContext: unknown,
  ): Promise<WorkflowRoute> {
    this.pausedBySession.delete(sessionKey)
    await this.hub.append(withOptionalSession({
      type: 'edmore.workflow.resumed',
      source: 'edmore-plan-judge',
      scope: 'workflow',
      workflow_id: paused.plan.workflow_id,
      ...correlationId === undefined ? {} : { correlation_id: correlationId },
      payload: {
        user_reply: prompt,
        previous_pause: paused.state,
        ...confirmationContext === undefined ? {} : { confirmation_context: confirmationContext },
      },
    }, eventSessionId))
    this.activeBySession.set(sessionKey, {
      plan: paused.plan,
      nextStepIndex: numberOr(paused.state.next_step_index, 0),
      confirmedStepIndex: numberOr(paused.state.next_step_index, 0),
    })
    this.updateInstrumentLeases(sessionKey, paused.plan, 'active', 'Paused workflow was resumed.')
    await this.saveState()
    const dispatch = this.nextLoopDispatch(sessionKey, paused.plan.workflow_id, {
      userMessage: prompt,
      pauseReason: paused.reason,
      pauseState: paused.state,
      confirmationContext,
    })
    if (dispatch === undefined) return { action: 'blocked', message: 'Workflow has no executable next step.', plan: paused.plan }
    return {
      action: 'execute',
      workflowId: paused.plan.workflow_id,
      executionPrompt: dispatch.prompt,
      role: dispatch.role,
      plan: paused.plan,
    }
  }

  private async createAndQueuePlan(prompt: string, event: EdmoreEvent, previousPlan?: PendingPlan, parentReturn?: ParentPlanReturn): Promise<WorkflowRoute> {
    if (previousPlan !== undefined) {
      this.pending.delete(previousPlan.workflow_id)
      this.pendingBySession.delete(event.session_id ?? previousPlan.session_id ?? 'default')
      this.archived.push(previousPlan)
      await this.saveState()
    }
    const workflowId = randomUUID()
    let plan: PendingPlan
    try {
      plan = await this.generatePlan(workflowId, prompt, event.session_id, previousPlan, parentReturn)
    } catch (error) {
      const message = `Planning failed before approval: ${error instanceof Error ? error.message : String(error)}`
      await this.emitAssistantMessage(event, message)
      await this.hub.append(withOptionalSession({
        type: 'edmore.workflow.failed',
        source: 'edmore-plan-judge',
        scope: 'workflow',
        workflow_id: workflowId,
        correlation_id: event.event_id,
        payload: { stage: 'planning', error: message },
      }, event.session_id))
      return { action: 'blocked', message }
    }
    plan = await this.autoRepairAndJudge(plan)
    await this.hub.append(withOptionalSession({
      type: 'edmore.plan.generated',
      source: 'edmore-plan-judge',
      scope: 'workflow',
      workflow_id: workflowId,
      correlation_id: event.event_id,
      payload: plan,
    }, event.session_id))
    await this.hub.append(withOptionalSession({
      type: 'edmore.plan.judged',
      source: 'edmore-plan-judge',
      scope: 'workflow',
      workflow_id: workflowId,
      correlation_id: event.event_id,
      payload: plan.judge_report,
    }, event.session_id))
    if (plan.judge_replan_history.length > 0) {
      await this.hub.append(withOptionalSession({
        type: 'edmore.plan.replan_requested',
        source: 'edmore-plan-judge',
        scope: 'workflow',
        workflow_id: workflowId,
        correlation_id: event.event_id,
        payload: { history: plan.judge_replan_history },
      }, event.session_id))
    }
    if (plan.judge_report.status !== 'pass') {
      await this.hub.append(withOptionalSession({
        type: 'edmore.custom.plan.repair_exhausted',
        source: 'edmore-plan-judge',
        scope: 'workflow',
        workflow_id: workflowId,
        correlation_id: event.event_id,
        payload: {
          plan,
          attempts: plan.judge_replan_history.length,
          max_attempts: Math.max(0, Math.floor(this.autoRepairMaxAttempts)),
          issues: plan.judge_report.issues,
        },
      }, event.session_id))
      const issueLines = plan.judge_report.issues.length > 0
        ? plan.judge_report.issues.map(issue => `- ${issue.step_id === undefined ? '' : `Step ${issue.step_id}: `}${issue.message}`)
        : ['- The judge did not provide a structured issue.']
      const message = [
        `Plan was not queued for approval after ${plan.judge_replan_history.length} automatic repair attempt(s).`,
        '',
        plan.judge_report.summary,
        '',
        'Problems to resolve:',
        ...issueLines,
        '',
        'Tell me how to revise the approach, provide the missing information, or submit a new task.',
      ].join('\n')
      await this.emitAssistantMessage(event, message)
      await this.saveState()
      return { action: 'blocked', message, plan }
    }
    this.pending.set(workflowId, plan)
    this.pendingBySession.set(event.session_id ?? 'default', workflowId)
    await this.saveState()
    await this.hub.append(withOptionalSession({
      type: 'edmore.approval.requested',
      source: 'edmore-plan-judge',
      scope: 'workflow',
      workflow_id: workflowId,
      correlation_id: event.event_id,
      payload: plan,
    }, event.session_id))
    await this.emitAssistantMessage(event, this.formatPlanAwaitingApproval(plan))
    return { action: 'planned', plan, message: 'Plan is waiting for user approval.' }
  }

  async beforeLoopToolCall(
    harnessSessionId: string | undefined,
    agent: string,
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<void> {
    await this.ensureHydrated()
    const sessionId = this.sessionIdForHarnessAgent(harnessSessionId)
    if (sessionId === undefined) return
    const active = this.activeBySession.get(sessionId)
    if (active === undefined) return
    const step = active.plan.steps[active.nextStepIndex]
    if (step === undefined) return
    const inFlight = this.inFlightToolCalls.get(sessionId)
    if (inFlight !== undefined && inFlight.callId !== callId) {
      throw new Error(`EDMORE approved-plan gate blocked concurrent tool call. Step ${inFlight.stepId} in workflow ${inFlight.workflowId} is still in flight.`)
    }
    if (step.agent !== agent || step.tool_name !== toolName) {
      throw new Error(`EDMORE approved-plan gate blocked out-of-order tool call. Expected step ${step.step_id}: ${nionSwiftHarnessToolName(step.agent, step.tool_name)}, got ${nionSwiftHarnessToolName(agent, toolName)}.`)
    }
    if (step.required_inputs.length > 0 && active.confirmedStepIndex !== active.nextStepIndex) {
      if (!this.pausedBySession.has(sessionId)) {
        await this.pauseBeforeStep(active.plan, step, active.nextStepIndex, sessionId, callId)
      }
      throw new Error(`EDMORE workflow is paused before step ${step.step_id}. Required input: ${step.required_inputs.join('; ')}.`)
    }
    for (const [key, value] of Object.entries(step.arguments)) {
      if (value === null || isPlaceholder(value)) continue
      if (JSON.stringify(args[key]) !== JSON.stringify(value)) {
        throw new Error(`EDMORE approved-plan gate blocked changed argument '${key}' for step ${step.step_id}.`)
      }
    }
    this.inFlightToolCalls.set(sessionId, {
      workflowId: active.plan.workflow_id,
      stepIndex: active.nextStepIndex,
      stepId: step.step_id,
      callId,
    })
    this.updateInstrumentLeases(sessionId, active.plan, 'in_flight', `Executing step ${step.step_id}: ${step.goal}`)
    await this.saveState()
  }

  releaseLoopToolCall(harnessSessionId: string | undefined, callId: string): void {
    const sessionId = this.sessionIdForHarnessAgent(harnessSessionId)
    if (sessionId === undefined) return
    const inFlight = this.inFlightToolCalls.get(sessionId)
    if (inFlight?.callId === callId) this.inFlightToolCalls.delete(sessionId)
  }

  async afterLoopToolResult(
    harnessSessionId: string | undefined,
    agent: string,
    toolName: string,
    callId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureHydrated()
    const sessionId = this.sessionIdForHarnessAgent(harnessSessionId)
    if (sessionId === undefined) return
    try {
      const active = this.activeBySession.get(sessionId)
      if (active === undefined) return
      const step = active.plan.steps[active.nextStepIndex]
      if (step === undefined || step.agent !== agent || step.tool_name !== toolName) return
      const inFlight = this.inFlightToolCalls.get(sessionId)
      if (inFlight !== undefined && inFlight.callId !== callId) {
        throw new Error(`EDMORE approved-plan gate received result for call ${callId}, but call ${inFlight.callId} is in flight.`)
      }
      const content = Array.isArray(result.content) ? result.content : []
      const resultText = contentText(projectMcpContent(content, toolName))
      if (mcpResultLooksFailed(result, resultText)) {
        await this.handleRuntimeBlocker(active, step, active.nextStepIndex, sessionId, callId, resultText || 'NionSwift MCP tool reported failure.')
        return
      }
      await this.hub.append(withOptionalSession({
        type: 'edmore.hardware.observed',
        source: 'edmore-plan-judge-loop',
        scope: 'workflow',
        workflow_id: active.plan.workflow_id,
        correlation_id: callId,
        payload: {
          step_id: step.step_id,
          tool: nionSwiftHarnessToolName(agent, toolName),
          text: resultText,
        },
      }, sessionId))
      active.nextStepIndex += 1
      delete active.confirmedStepIndex
      this.updateInstrumentLeases(sessionId, active.plan, 'active', `Workflow advanced after step ${step.step_id}.`)
      await this.saveState()
      const nextStep = active.plan.steps[active.nextStepIndex]
      if (nextStep === undefined) {
        await this.completeActiveWorkflow(active, sessionId, callId)
        return
      }
      if (nextStep.required_inputs.length > 0) {
        await this.pauseBeforeStep(active.plan, nextStep, active.nextStepIndex, sessionId, callId)
      }
    } finally {
      this.releaseLoopToolCall(harnessSessionId, callId)
      await this.saveState()
    }
  }

  async handleLoopToolError(
    harnessSessionId: string | undefined,
    agent: string,
    toolName: string,
    callId: string,
    error: unknown,
  ): Promise<void> {
    await this.ensureHydrated()
    const sessionId = this.sessionIdForHarnessAgent(harnessSessionId)
    if (sessionId === undefined) return
    const active = this.activeBySession.get(sessionId)
    const inFlight = this.inFlightToolCalls.get(sessionId)
    if (active === undefined || inFlight?.callId !== callId) return
    const step = active.plan.steps[inFlight.stepIndex]
    if (step === undefined || step.agent !== agent || step.tool_name !== toolName) return
    const detail = error instanceof Error ? error.message : String(error)
    const reason = `MCP transport failed while step ${step.step_id} was in flight. The hardware result is unknown and must be verified before continuing. ${detail}`
    this.activeBySession.delete(sessionId)
    this.pausedBySession.set(sessionId, {
      plan: active.plan,
      reason,
      state: {
        step_id: step.step_id,
        agent,
        tool_name: toolName,
        next_step_index: inFlight.stepIndex,
        required_inputs: [
          'verify_in_flight_tool_result_after_transport_error',
          'confirm whether the in-flight tool completed successfully before resuming',
        ],
        previous_call_id: callId,
        transport_error: true,
        error: detail,
      },
    })
    this.updateInstrumentLeases(sessionId, active.plan, 'verify_required', reason)
    await this.hub.append(withOptionalSession({
      type: 'edmore.workflow.paused',
      source: 'edmore-plan-judge-loop',
      scope: 'workflow',
      workflow_id: active.plan.workflow_id,
      correlation_id: callId,
      payload: {
        reason,
        step,
        next_step_index: inFlight.stepIndex,
        verify_required: true,
        transport_error: true,
      },
    }, sessionId))
    this.releaseLoopToolCall(harnessSessionId, callId)
    await this.saveState()
    await this.emitAssistantText(sessionId, callId, [
      `Workflow paused at step ${step.step_id}: ${step.goal}`,
      '',
      'The MCP connection failed after the call started, so the physical result is unknown.',
      'Verify the instrument state, then confirm the actual result before resuming.',
    ].join('\n'))
  }

  private async completeActiveWorkflow(active: ActiveWorkflowState, sessionId: string, correlationId: string): Promise<void> {
    this.activeBySession.delete(sessionId)
    this.releaseInstrumentLeases(sessionId, active.plan.workflow_id)
    await this.hub.append(withOptionalSession({
      type: 'edmore.workflow.completed',
      source: 'edmore-plan-judge-loop',
      scope: 'workflow',
      workflow_id: active.plan.workflow_id,
      correlation_id: correlationId,
      payload: { steps: active.plan.steps.length },
    }, sessionId))
    const parent = active.plan.parent_return
    if (parent === undefined) {
      await this.saveState()
      return
    }
    this.activeBySession.set(sessionId, {
      plan: parent.plan,
      nextStepIndex: parent.next_step_index,
    })
    this.updateInstrumentLeases(sessionId, parent.plan, 'active', `Returned from child workflow ${active.plan.workflow_id}.`)
    await this.saveState()
    await this.hub.append(withOptionalSession({
      type: 'edmore.workflow.resumed',
      source: 'edmore-plan-judge-loop',
      scope: 'workflow',
      workflow_id: parent.workflow_id,
      correlation_id: correlationId,
      payload: {
        child_workflow_id: active.plan.workflow_id,
        plan: parent.plan,
        next_step_index: parent.next_step_index,
        reason: parent.reason,
      },
    }, sessionId))
    await this.emitAssistantText(
      sessionId,
      correlationId,
      `Subplan completed. Returning to parent workflow ${parent.workflow_id} at step ${parent.next_step_index + 1}.`,
    )
    const parentStep = parent.plan.steps[parent.next_step_index]
    if (parentStep !== undefined && parentStep.required_inputs.length > 0) {
      await this.pauseBeforeStep(parent.plan, parentStep, parent.next_step_index, sessionId, correlationId)
    }
  }

  private async handleRuntimeBlocker(
    active: ActiveWorkflowState,
    step: PlanStep,
    nextStepIndex: number,
    sessionId: string,
    correlationId: string,
    blocker: string,
  ): Promise<void> {
    this.activeBySession.delete(sessionId)
    await this.hub.append(withOptionalSession({
      type: 'edmore.workflow.paused',
      source: 'edmore-plan-judge-loop',
      scope: 'workflow',
      workflow_id: active.plan.workflow_id,
      correlation_id: correlationId,
      payload: {
        reason: blocker,
        step,
        next_step_index: nextStepIndex,
        can_create_subplan: true,
      },
    }, sessionId))
    this.pausedBySession.set(sessionId, {
      plan: active.plan,
      reason: blocker,
      state: {
        step_id: step.step_id,
        agent: step.agent,
        tool_name: step.tool_name,
        next_step_index: nextStepIndex,
        required_inputs: step.required_inputs,
        blocker,
      },
    })
    this.updateInstrumentLeases(sessionId, active.plan, 'paused', blocker)
    await this.saveState()
    await this.emitAssistantText(sessionId, correlationId, [
      `Workflow paused at step ${step.step_id}: ${step.goal}`,
      '',
      blocker,
      '',
      "Reply 'confirm' when the requested physical adjustment/input is complete. Ask for a subplan if you want me to work around this blocker.",
    ].join('\n'))
  }

  private async proposeRuntimeSubplan(
    plan: PendingPlan,
    step: PlanStep,
    nextStepIndex: number,
    blocker: string,
    sessionId: string,
    correlationId: string,
    userRequest?: string,
  ): Promise<RuntimeSubplanProposal | undefined> {
    if (this.roleRunner === undefined) return undefined
    const contracts = [...(await this.loadSkillContracts()).values()]
    try {
      const text = await this.roleRunner.runRoleOnce(sessionId, 'orchestrator', [
        'An approved EDMORE workflow hit a runtime blocker.',
        'Decide whether the assistant should propose a child PlanReview that can help resolve the blocker before returning to the parent workflow.',
        'Return only JSON with this exact shape:',
        JSON.stringify({
          needs_subplan: true,
          subplan_goal: 'concrete child-plan goal, or empty string when no subplan is appropriate',
          user_message: 'short message explaining what help is proposed',
          reason: 'short reason',
        }, null, 2),
        '',
        'Rules:',
        '- A child plan may use any available skill if it can obtain missing inputs, inspect state, recommend parameters, recover from a failed tool, or prepare the parent step.',
        '- Do not hard-code a specific skill. Choose from available skill contracts by reasoning from the blocker.',
        '- If the blocker requires direct human choice or physical adjustment with no useful skill, set needs_subplan=false.',
        '- The child plan will require user approval before execution and will return to the parent workflow after completion.',
        '',
        `Available skills:\n${JSON.stringify(contracts, null, 2)}`,
        '',
        `Parent PlanReview:\n${JSON.stringify(plan, null, 2)}`,
        '',
        `Blocked parent step index: ${nextStepIndex}`,
        `Blocked parent step:\n${JSON.stringify(step, null, 2)}`,
        '',
        `Runtime blocker:\n${blocker}`,
        '',
        `User request after pause:\n${userRequest ?? ''}`,
      ].join('\n'), {
        event_id: correlationId,
        cursor: 0,
        timestamp: new Date().toISOString(),
        source: 'edmore-runtime-subplan',
        type: 'edmore.custom.subplan.proposed',
        scope: 'workflow',
        session_id: sessionId,
        workflow_id: plan.workflow_id,
        correlation_id: correlationId,
        payload: { blocker },
      }, {
        hidden: true,
        source: 'edmore-orchestrator-agent',
      })
      const raw = asRecord(parseJsonObjectFromText(text))
      if (raw.needs_subplan !== true) return undefined
      const subplanGoal = optionalString(raw.subplan_goal)
      if (subplanGoal === undefined) return undefined
      return {
        subplan_goal: subplanGoal,
        user_message: optionalString(raw.user_message) ?? `I can create a child plan to resolve: ${blocker}`,
        reason: optionalString(raw.reason) ?? 'Runtime blocker may be recoverable with another skill.',
      }
    } catch {
      return undefined
    }
  }

  private formatRuntimeSubplanProposal(paused: PausedWorkflowState, proposal: RuntimeSubplanProposal): string {
    const stepId = optionalString(paused.state.step_id)
    const toolName = optionalString(paused.state.tool_name)
    return [
      stepId === undefined
        ? 'The approved workflow is paused.'
        : `The approved workflow is paused at step ${stepId}${toolName === undefined ? '' : ` (${toolName})`}.`,
      '',
      paused.reason,
      '',
      'Suggested recovery direction:',
      proposal.user_message,
      '',
      `Proposed child-plan goal: ${proposal.subplan_goal}`,
      '',
      "Reply 'approve' to create and judge a child plan from this idea. Press Confirm only when you have completed the currently requested physical adjustment/input and want to resume the parent plan.",
    ].join('\n')
  }

  private async classifyRuntimeProposalIntent(prompt: string, event: EdmoreEvent, paused: PausedWorkflowState): Promise<PausedWorkflowIntent | 'approve'> {
    if (this.roleRunner === undefined) return 'wait'
    try {
      const text = await this.roleRunner.runRoleOnce(event.session_id ?? paused.plan.session_id ?? 'default', 'orchestrator', [
        'Classify the user response to a proposed EDMORE runtime recovery direction.',
        'Return only JSON with this exact shape:',
        JSON.stringify({
          intent: 'approve | resume | reject | revise | question | wait',
          reason: 'short reason',
        }, null, 2),
        '',
        'Meanings:',
        '- approve: user agrees that EDMORE should create and judge a child plan from the proposed recovery direction.',
        '- resume: user confirms the physical adjustment/input requested by the paused parent workflow is complete and wants to continue the parent workflow, not create a child plan.',
        '- reject: user declines, cancels, or says not to use this recovery direction.',
        '- revise: user asks to change the recovery direction before planning.',
        '- question: user asks about the recovery direction, blocker, parent workflow, or why this is needed.',
        '- wait: unclear or non-actionable message.',
        '',
        `User message:\n${prompt}`,
        '',
        `Paused workflow state:\n${JSON.stringify(paused.state, null, 2)}`,
        '',
        `Recovery proposal:\n${JSON.stringify(paused.recovery_proposal, null, 2)}`,
      ].join('\n'), event, {
        hidden: true,
        source: 'edmore-orchestrator-agent',
      })
      const raw = asRecord(parseJsonObjectFromText(text))
      const intent = raw.intent
      if (intent === 'approve' || intent === 'resume' || intent === 'reject' || intent === 'revise' || intent === 'question' || intent === 'wait') return intent
      return 'wait'
    } catch {
      return 'wait'
    }
  }

  private async classifyPausedWorkflowIntent(prompt: string, event: EdmoreEvent, paused: PausedWorkflowState): Promise<PausedWorkflowIntent> {
    if (this.roleRunner === undefined) return 'wait'
    try {
      const text = await this.roleRunner.runRoleOnce(event.session_id ?? paused.plan.session_id ?? 'default', 'orchestrator', [
        'Classify the user message while an approved EDMORE workflow is paused at a step.',
        'Return only JSON with this exact shape:',
        JSON.stringify({
          intent: 'resume | subplan | reject | revise | question | wait',
          reason: 'short reason',
        }, null, 2),
        '',
        'Intent meanings:',
        '- resume: user confirms the requested physical adjustment/input is complete, or provides the requested value/context needed to continue the same approved plan.',
        '- subplan: user wants EDMORE to create a child plan, workaround, recovery plan, helper plan, or use another skill to solve the blocker before returning.',
        '- reject: user cancels or rejects the paused workflow.',
        '- revise: user wants to change the parent plan or recovery direction before continuing.',
        '- question: user asks about the pause, blocker, current step, plan, tool, or safety reason.',
        '- wait: unclear or non-actionable.',
        '',
        'Important distinctions:',
        '- A bare "confirm", "confirmed", "go ahead", or "done" normally means resume when the pause requested a user confirmation.',
        '- Confirming ROI, scan geometry, parameters, or a manual microscope adjustment means resume, not subplan.',
        '- Do not classify as subplan unless the user explicitly asks for help/recovery/subplan/workaround or the message cannot satisfy the paused step.',
        '',
        `Paused workflow reason:\n${paused.reason}`,
        '',
        `Paused workflow state:\n${JSON.stringify(paused.state, null, 2)}`,
        '',
        `User message:\n${prompt}`,
      ].join('\n'), event, {
        hidden: true,
        source: 'edmore-orchestrator-agent',
      })
      const raw = asRecord(parseJsonObjectFromText(text))
      const intent = raw.intent
      if (intent === 'resume' || intent === 'subplan' || intent === 'reject' || intent === 'revise' || intent === 'question' || intent === 'wait') return intent
      return 'wait'
    } catch {
      return 'wait'
    }
  }

  private async answerPausedWorkflowQuestion(prompt: string, event: EdmoreEvent, paused: PausedWorkflowState): Promise<void> {
    if (this.roleRunner === undefined) {
      await this.emitAssistantMessage(event, paused.reason)
      return
    }
    await this.roleRunner.runRoleOnce(event.session_id ?? paused.plan.session_id ?? 'default', 'orchestrator', [
      'Answer the user question about this paused EDMORE workflow.',
      'Do not resume, reject, revise, create a PlanReview, or execute tools.',
      '',
      `User question:\n${prompt}`,
      '',
      `Paused workflow reason:\n${paused.reason}`,
      '',
      `Paused workflow state:\n${JSON.stringify(paused.state, null, 2)}`,
      '',
      `Parent PlanReview:\n${JSON.stringify(paused.plan, null, 2)}`,
    ].join('\n'), event)
  }

  private async reviseRuntimeSubplanProposal(prompt: string, event: EdmoreEvent, paused: PausedWorkflowState): Promise<RuntimeSubplanProposal | undefined> {
    if (this.roleRunner === undefined) return undefined
    const contracts = [...(await this.loadSkillContracts()).values()]
    try {
      const text = await this.roleRunner.runRoleOnce(event.session_id ?? paused.plan.session_id ?? 'default', 'orchestrator', [
        'Revise the proposed EDMORE runtime recovery direction. Do not create a PlanReview yet.',
        'Return only JSON with this exact shape:',
        JSON.stringify({
          subplan_goal: 'concrete child-plan goal',
          user_message: 'short message explaining the revised recovery direction',
          reason: 'short reason',
        }, null, 2),
        '',
        'Rules:',
        '- This is only a rough recovery direction for user approval.',
        '- Do not list exact executable steps unless the user explicitly asked for that detail.',
        '- The actual PlanReview will be created only after the user approves this direction.',
        '',
        `User requested change:\n${prompt}`,
        '',
        `Available skills:\n${JSON.stringify(contracts, null, 2)}`,
        '',
        `Parent PlanReview:\n${JSON.stringify(paused.plan, null, 2)}`,
        '',
        `Paused workflow state:\n${JSON.stringify(paused.state, null, 2)}`,
        '',
        `Previous recovery proposal:\n${JSON.stringify(paused.recovery_proposal, null, 2)}`,
      ].join('\n'), event, {
        hidden: true,
        source: 'edmore-orchestrator-agent',
      })
      const raw = asRecord(parseJsonObjectFromText(text))
      const subplanGoal = optionalString(raw.subplan_goal)
      if (subplanGoal === undefined) return undefined
      return {
        subplan_goal: subplanGoal,
        user_message: optionalString(raw.user_message) ?? `I can create a child plan to resolve: ${paused.reason}`,
        reason: optionalString(raw.reason) ?? 'Runtime blocker may be recoverable with another skill.',
      }
    } catch {
      return undefined
    }
  }

  private async answerRuntimeSubplanQuestion(prompt: string, event: EdmoreEvent, paused: PausedWorkflowState): Promise<void> {
    if (this.roleRunner === undefined) {
      await this.emitAssistantMessage(event, this.formatRuntimeSubplanProposal(paused, paused.recovery_proposal!))
      return
    }
    await this.roleRunner.runRoleOnce(event.session_id ?? paused.plan.session_id ?? 'default', 'orchestrator', [
      'Answer the user question about this paused EDMORE workflow and proposed runtime recovery direction.',
      'Do not create a PlanReview. Do not approve, reject, revise, or execute anything.',
      '',
      `User question:\n${prompt}`,
      '',
      `Paused workflow state:\n${JSON.stringify(paused.state, null, 2)}`,
      '',
      `Recovery proposal:\n${JSON.stringify(paused.recovery_proposal, null, 2)}`,
      '',
      `Parent PlanReview:\n${JSON.stringify(paused.plan, null, 2)}`,
    ].join('\n'), event)
  }

  private async pauseBeforeStep(
    plan: PendingPlan,
    firstBlockedStep: PlanStep,
    nextStepIndex: number,
    sessionId: string | undefined,
    correlationId: string | undefined,
  ): Promise<WorkflowRoute> {
      const reason = [
        `Approved workflow is paused before step ${firstBlockedStep.step_id}: ${firstBlockedStep.goal}`,
        '',
        'Required user confirmation/input:',
        ...firstBlockedStep.required_inputs.map(item => `- ${item}`),
        '',
        "Reply 'confirm' to continue this approved workflow, or provide the requested values.",
      ].join('\n')
      this.pausedBySession.set(sessionId ?? plan.session_id ?? 'default', {
        plan,
        reason,
        state: {
          step_id: firstBlockedStep.step_id,
          agent: firstBlockedStep.agent,
          tool_name: firstBlockedStep.tool_name,
          next_step_index: nextStepIndex,
          required_inputs: firstBlockedStep.required_inputs,
        },
      })
      this.updateInstrumentLeases(sessionId ?? plan.session_id ?? 'default', plan, 'paused', reason)
      await this.saveState()
      await this.hub.append(withOptionalSession({
        type: 'edmore.workflow.paused',
        source: 'edmore-plan-judge',
        scope: 'workflow',
        workflow_id: plan.workflow_id,
        ...correlationId === undefined ? {} : { correlation_id: correlationId },
        payload: {
          reason,
          step: firstBlockedStep,
          required_inputs: firstBlockedStep.required_inputs,
        },
      }, sessionId))
      await this.emitAssistantText(sessionId, correlationId, reason)
      return { action: 'blocked', workflowId: plan.workflow_id, message: reason, plan }
  }

  nextLoopDispatch(
    sessionId: string,
    workflowId?: string,
    resume?: {
      userMessage: string
      pauseReason: string
      pauseState: Record<string, unknown>
      confirmationContext?: unknown
    },
  ): LoopDispatch | undefined {
    if (this.pausedBySession.has(sessionId)) return undefined
    const active = this.activeBySession.get(sessionId)
    if (active === undefined) return undefined
    if (workflowId !== undefined && active.plan.workflow_id !== workflowId) return undefined
    const step = active.plan.steps[active.nextStepIndex]
    if (step === undefined) return undefined
    return {
      workflowId: active.plan.workflow_id,
      role: executorRoleForMcpAgent(step.agent),
      step,
      prompt: this.formatStepLoopPrompt(active.plan, active.nextStepIndex, step, resume),
    }
  }

  private async shouldPlan(prompt: string, event: EdmoreEvent): Promise<boolean> {
    if (this.roleRunner === undefined) throw new Error('LLM orchestrator is unavailable; EDMORE has no deterministic planning fallback configured.')
    const payload = asRecord(event.payload)
    const contracts = [...(await this.loadSkillContracts()).values()].map(contract => ({
      skill_id: contract.skill_id,
      name: contract.name,
      agents: contract.agents,
      required_tools: contract.required_tools,
      ordered_tools: contract.ordered_tools,
    }))
    try {
      const text = await this.roleRunner.runRoleOnce(event.session_id ?? 'default', 'orchestrator', [
        'Decide whether this EDMORE user query requires a PlanReview before answering.',
        'A PlanReview is required for microscope hardware changes, acquisition, ptychography/reconstruction submission, parameter updates, multi-step workflows, or any action that will call NionSwift MCP tools.',
        'A PlanReview is not required for simple explanation, status reading, tool listing, or harmless conversation.',
        'Do not use keywords alone. Decide from user intent, current event payload, available skills, and whether the task needs tool execution.',
        'If the message is only a confirmation for an already-paused approved workflow, it should have been handled before this router; do not turn it into a new plan.',
        'Return only JSON with this exact shape: {"needs_plan":true|false,"reason":"short reason"}.',
        '',
        `Event payload:\n${JSON.stringify(payload, null, 2)}`,
        '',
        `Available skills:\n${JSON.stringify(contracts, null, 2)}`,
        '',
        `User query:\n${prompt}`,
      ].join('\n'), event, {
        hidden: true,
        source: 'edmore-orchestrator-agent',
      })
      const decision = asRecord(parseJsonObjectFromText(text))
      if (typeof decision.needs_plan !== 'boolean') throw new Error('router did not return boolean needs_plan')
      return decision.needs_plan
    } catch (error) {
      throw new Error(`LLM planning router did not return a usable decision: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async createPlanningProposal(prompt: string, event: EdmoreEvent, previousProposal?: PlanningProposal): Promise<WorkflowRoute> {
    if (this.roleRunner === undefined) throw new Error('LLM orchestrator is unavailable; cannot create a planning proposal.')
    const sessionId = event.session_id ?? 'default'
    if (previousProposal !== undefined) {
      this.planningProposals.delete(previousProposal.proposal_id)
      this.planningProposalBySession.delete(sessionId)
      await this.saveState()
    }
    const contracts = [...(await this.loadSkillContracts()).values()].map(contract => ({
      skill_id: contract.skill_id,
      name: contract.name,
      agents: contract.agents,
      ordered_tools: contract.ordered_tools,
    }))
    const text = await this.roleRunner.runRoleOnce(event.session_id ?? 'default', 'orchestrator', [
      'Create a high-level EDMORE planning direction for the user to approve before a formal PlanReview is generated.',
      'Do not create executable steps. Do not judge a plan. Do not call tools.',
      'Return only JSON with this exact shape:',
      JSON.stringify({
        plan_goal: 'concrete high-level goal for the later PlanReview',
        user_message: 'short user-facing explanation of the proposed approach',
        reason: 'short reason why this needs a formal PlanReview',
      }, null, 2),
      '',
      'Rules:',
      '- Keep the proposal short and conceptual.',
      '- Mention the main agents or skills only if useful to clarify the route.',
      '- Ask the user to approve this direction before formal planning.',
      '- If revising, incorporate the previous direction and the user change.',
      '',
      `Available skills:\n${JSON.stringify(contracts, null, 2)}`,
      '',
      previousProposal === undefined ? '' : `Previous planning direction:\n${JSON.stringify(previousProposal, null, 2)}`,
      previousProposal === undefined ? '' : '',
      `User request:\n${prompt}`,
    ].join('\n'), event, {
      hidden: true,
      source: 'edmore-orchestrator-agent',
    })
    const raw = asRecord(parseJsonObjectFromText(text))
    const proposal: PlanningProposal = {
      proposal_id: randomUUID(),
      ...event.session_id === undefined ? {} : { session_id: event.session_id },
      prompt,
      plan_goal: optionalString(raw.plan_goal) ?? prompt,
      user_message: optionalString(raw.user_message) ?? `I can create and judge a PlanReview for: ${prompt}`,
      reason: optionalString(raw.reason) ?? 'This request needs a formal PlanReview before execution.',
    }
    this.planningProposals.set(proposal.proposal_id, proposal)
    this.planningProposalBySession.set(sessionId, proposal.proposal_id)
    await this.saveState()
    await this.hub.append(withOptionalSession({
      type: 'edmore.custom.planning_proposal.requested',
      source: 'edmore-plan-judge',
      scope: 'workflow',
      correlation_id: event.event_id,
      payload: proposal,
    }, event.session_id))
    await this.emitAssistantMessage(event, this.formatPlanningProposal(proposal))
    return { action: 'blocked', message: 'Planning direction is waiting for user approval.' }
  }

  private formatPlanningProposal(proposal: PlanningProposal): string {
    return [
      proposal.user_message,
      '',
      `Proposed planning goal: ${proposal.plan_goal}`,
      '',
      "Reply 'approve' or press Approve to create and judge the formal PlanReview from this direction. Tell me what to change if this direction is not right.",
    ].join('\n')
  }

  private async classifyPlanningProposalIntent(prompt: string, event: EdmoreEvent, proposal: PlanningProposal): Promise<PlanningProposalIntent> {
    if (this.roleRunner === undefined) return 'wait'
    try {
      const text = await this.roleRunner.runRoleOnce(event.session_id ?? proposal.session_id ?? 'default', 'orchestrator', [
        'Classify the user message while an EDMORE planning direction is waiting for approval before formal PlanReview creation.',
        'Return only JSON with this exact shape:',
        JSON.stringify({
          intent: 'approve | reject | revise | new_query | question | wait',
          reason: 'short reason',
        }, null, 2),
        '',
        'Intent meanings:',
        '- approve: user agrees to create and judge a formal PlanReview from this proposed direction.',
        '- reject: user declines or cancels this proposed planning direction.',
        '- revise: user wants to change the proposed direction before formal planning.',
        '- new_query: user asks a separate task unrelated to this planning direction.',
        '- question: user asks about the proposed direction, agents, skills, safety, or why planning is needed.',
        '- wait: unclear or non-actionable.',
        '',
        `Planning direction:\n${JSON.stringify(proposal, null, 2)}`,
        '',
        `User message:\n${prompt}`,
      ].join('\n'), event, {
        hidden: true,
        source: 'edmore-orchestrator-agent',
      })
      const raw = asRecord(parseJsonObjectFromText(text))
      const intent = raw.intent
      if (intent === 'approve' || intent === 'reject' || intent === 'revise' || intent === 'new_query' || intent === 'question' || intent === 'wait') return intent
      return 'wait'
    } catch {
      return 'wait'
    }
  }

  private async answerPlanningProposalQuestion(prompt: string, event: EdmoreEvent, proposal: PlanningProposal): Promise<void> {
    if (this.roleRunner === undefined) {
      await this.emitAssistantMessage(event, this.formatPlanningProposal(proposal))
      return
    }
    await this.roleRunner.runRoleOnce(event.session_id ?? proposal.session_id ?? 'default', 'orchestrator', [
      'Answer the user question about this proposed EDMORE planning direction.',
      'Do not create a PlanReview. Do not approve, reject, revise, or execute tools.',
      '',
      `Planning direction:\n${JSON.stringify(proposal, null, 2)}`,
      '',
      `User question:\n${prompt}`,
    ].join('\n'), event, {
      source: 'edmore-orchestrator-agent',
    })
  }

  private async classifyPendingPlanIntent(prompt: string, event: EdmoreEvent, pending: PendingPlan): Promise<PendingPlanIntent> {
    if (this.roleRunner === undefined) return 'wait'
    try {
      const text = await this.roleRunner.runRoleOnce(event.session_id ?? pending.session_id ?? 'default', 'orchestrator', [
        'Classify the user message while an EDMORE PlanReview is waiting for approval.',
        'Return only JSON with this exact shape:',
        JSON.stringify({
          intent: 'approve | reject | revise | new_query | question | wait',
          reason: 'short reason',
        }, null, 2),
        '',
        'Intent meanings:',
        '- approve: user clearly wants to execute/continue the pending plan.',
        '- reject: user clearly cancels, rejects, or discards the pending plan.',
        '- revise: user wants to modify the pending plan, parameters, order, tools, or constraints.',
        '- new_query: user is asking for a different task that should not be treated as approval/revision of the pending plan.',
        '- question: user asks about the pending plan, judge report, risks, tools, or why the system chose a step.',
        '- wait: unclear or non-actionable message.',
        '',
        'Important:',
        '- Do not classify a question as revise just because it contains a question mark.',
        '- If the user asks "what tools do you have", "why this plan", or "what will happen", classify as question.',
        '- If the user asks a separate new microscopy or analysis task, classify as new_query.',
        '',
        `Pending PlanReview:\n${JSON.stringify(pending, null, 2)}`,
        '',
        `User message:\n${prompt}`,
      ].join('\n'), event, {
        hidden: true,
        source: 'edmore-orchestrator-agent',
      })
      const raw = asRecord(parseJsonObjectFromText(text))
      const intent = raw.intent
      if (intent === 'approve' || intent === 'reject' || intent === 'revise' || intent === 'new_query' || intent === 'question' || intent === 'wait') {
        return intent
      }
      return 'wait'
    } catch {
      return 'wait'
    }
  }

  private async answerPendingPlanQuestion(prompt: string, event: EdmoreEvent, pending: PendingPlan): Promise<void> {
    if (this.roleRunner === undefined) {
      await this.emitAssistantMessage(event, this.formatPlanAwaitingApproval(pending))
      return
    }
    await this.roleRunner.runRoleOnce(event.session_id ?? pending.session_id ?? 'default', 'orchestrator', [
      'Answer the user question about the pending EDMORE PlanReview.',
      'Use the plan, judge report, required inputs, risks, and visible workflow state as the source of truth.',
      'Do not approve, reject, revise, or execute the plan.',
      'Be concise and explicit about what is waiting for user approval or input.',
      '',
      `Pending PlanReview:\n${JSON.stringify(pending, null, 2)}`,
      '',
      `User question:\n${prompt}`,
    ].join('\n'), event, {
      source: 'edmore-orchestrator-agent',
    })
  }

  private async generatePlan(workflowId: string, prompt: string, sessionId?: string, previousPlan?: PendingPlan, parentReturn?: ParentPlanReturn): Promise<PendingPlan> {
    const selected = await this.selectSkill(prompt, previousPlan)
    const contracts = await this.loadSkillContracts()
    const expanded = this.expandSkill(selected.skill_id, contracts)
    const candidates = this.candidateSkillContracts(selected, expanded, contracts)
    if (this.roleRunner !== undefined) {
      const plannerText = await this.roleRunner.runRoleOnce(sessionId ?? 'default', 'planner', await this.formatPlannerPrompt(workflowId, prompt, selected, expanded, candidates, previousPlan), {
        event_id: workflowId,
        cursor: 0,
        timestamp: new Date().toISOString(),
        source: 'edmore-plan-judge',
        type: 'edmore.plan.generated',
        scope: 'workflow',
        ...sessionId === undefined ? {} : { session_id: sessionId },
        workflow_id: workflowId,
        payload: { prompt },
      }, {
        hidden: true,
        source: 'edmore-planner-agent',
      })
      return this.normalizePlannerPlan(workflowId, prompt, sessionId, selected, expanded, candidates, plannerText, previousPlan, parentReturn)
    }
    const steps: PlanStep[] = []
    let counter = 1
    for (const contract of expanded) {
      for (const tool of contract.ordered_tools.length ? contract.ordered_tools : contract.required_tools) {
        const [agent, toolName] = splitFullToolName(tool, contract.agents[0] ?? 'agent_sem')
        const previousStep = steps.at(-1)
        steps.push({
          step_id: String(counter),
          agent,
          goal: goalForTool(contract, toolName),
          skill: contract.skill_id,
          tool_name: toolName,
          arguments: await this.defaultArguments(agent, toolName),
          required_inputs: requiredInputsForStep(contract.skill_id, agent, toolName, previousStep),
          expected_output: `The ${agent}.${toolName} step completes and returns a concrete status/result.`,
          on_success: String(counter + 1),
          on_failure: 'ask_user',
        })
        counter += 1
      }
    }
    const lastStep = steps.at(-1)
    if (lastStep !== undefined) steps[steps.length - 1] = { ...lastStep, on_success: 'done' }
    return {
      workflow_id: workflowId,
      ...sessionId === undefined ? {} : { session_id: sessionId },
      ...parentReturn === undefined ? {} : { parent_return: parentReturn },
      prompt,
      status: 'needs_approval',
      goal: prompt,
      summary: `Use the ${selected.name} skill workflow.`,
      steps,
      user_summary: `I prepared a skill-grounded plan for ${selected.name}.`,
      missing_inputs: [],
      risks: [
        'Hardware-changing and acquisition/server-submission steps require explicit approval and step-level confirmation gates.',
      ],
      judge_report: emptyJudgeReport(),
      judge_replan_history: previousPlan === undefined ? [] : [`Revised previous pending plan ${previousPlan.workflow_id}.`],
    }
  }

  private async formatPlannerPrompt(
    workflowId: string,
    prompt: string,
    selected: SkillContract,
    expanded: SkillContract[],
    candidates: SkillContract[],
    previousPlan?: PendingPlan,
  ): Promise<string> {
    return [
      'You are the EDMORE planner agent.',
      'Create a PlanReview JSON object for the user query using only the supplied EDMORE skills and MCP tool contracts.',
      'Do not execute any tool. Do not invent agents or tool names.',
      'The output must be only JSON, no Markdown fences and no commentary.',
      '',
      'Required JSON shape:',
      JSON.stringify({
        goal: 'string',
        summary: 'string',
        user_summary: 'string',
        missing_inputs: ['string'],
        risks: ['string'],
        steps: [{
          step_id: '1',
          agent: 'agent_sem',
          goal: 'short step goal',
          skill: selected.skill_id,
          tool_name: 'raw_mcp_tool_name',
          arguments: {},
          required_inputs: ['optional user gate'],
          expected_output: 'string',
          on_success: '2',
          on_failure: 'ask_user',
        }],
      }, null, 2),
      '',
      `workflow_id: ${workflowId}`,
      `User query:\n${prompt}`,
      '',
      `Selected primary skill:\n${JSON.stringify(selected, null, 2)}`,
      '',
      `Expanded skill contracts:\n${JSON.stringify(expanded, null, 2)}`,
      '',
      `Available supporting skill contracts:\n${JSON.stringify(candidates, null, 2)}`,
      '',
      `Skill instructions:\n${await this.renderSkillInstructions(candidates)}`,
      '',
      previousPlan === undefined ? '' : `Previous pending plan to revise:\n${JSON.stringify(previousPlan, null, 2)}`,
      previousPlan === undefined ? '' : '',
      'Hard requirements:',
      '- Preserve the exact ordered_tools order inside every skill you use.',
      '- For compound skills, expand the referenced skills as separate contiguous phases. For ptychography_on_sem, first use acquire_4d_stem steps with agent_sem, then use ptychography steps with agent_ptychography.',
      '- You may include supporting skills when they can obtain missing parameters, read state, recommend settings, or prepare another skill.',
      '- Choose supporting skills by reasoning from the available contracts and SKILL.md instructions; do not wait for the runtime to hard-route missing information.',
      '- Use raw MCP tool names in tool_name without the agent prefix. Correct: {"agent":"agent_sem","tool_name":"play_bf"}. Incorrect: {"agent":"agent_sem","tool_name":"agent_sem.play_bf"}.',
      '- Put only confirmations explicitly required by the skill in required_inputs. Do not add confirmations for ordinary steps or unknown parameters; use available context/UI values and pause on an actual tool error.',
      '- For values produced by previous steps, use placeholders such as "{{save_params.param_path}}".',
      '- For unknown optional values, omit them or use null; never use the string "None".',
    ].filter(line => line.length > 0).join('\n')
  }

  private async renderSkillInstructions(contracts: SkillContract[]): Promise<string> {
    const blocks: string[] = []
    for (const contract of contracts) {
      const candidates = [
        join(this.skillsRoot, contract.skill_id.replace(/_/g, '-'), 'SKILL.md'),
        join(this.skillsRoot, contract.skill_id, 'SKILL.md'),
      ]
      for (const candidate of candidates) {
        try {
          blocks.push(`# ${contract.skill_id}\n${await readFile(candidate, 'utf8')}`)
          break
        } catch {
          continue
        }
      }
    }
    return blocks.join('\n\n')
  }

  private normalizePlannerPlan(
    workflowId: string,
    prompt: string,
    sessionId: string | undefined,
    selected: SkillContract,
    expanded: SkillContract[],
    candidates: SkillContract[],
    plannerText: string,
    previousPlan?: PendingPlan,
    parentReturn?: ParentPlanReturn,
  ): PendingPlan {
    const raw = asRecord(parseJsonObjectFromText(plannerText))
    const expandedSkillIds = new Set(candidates.map(contract => contract.skill_id))
    const deterministicTools = expanded.flatMap(contract => {
      const tools = contract.ordered_tools.length > 0 ? contract.ordered_tools : contract.required_tools
      return tools.map(tool => ({ contract, tool }))
    })
    const candidateTools = candidates.flatMap(contract => {
      const tools = mergeUnique([...contract.required_tools, ...contract.ordered_tools, ...contract.optional_tools])
      return tools.map(tool => ({ contract, tool }))
    })
    const toolsBySkillAndName = new Map(candidateTools.map(item => [`${item.contract.skill_id}:${item.tool}`, item]))
    const rawStepsInput = Array.isArray(raw.steps) ? raw.steps : []
    const stepsInput = rawStepsInput.length > 0
      ? rawStepsInput
      : deterministicTools.map(() => ({}))
    const steps: PlanStep[] = stepsInput.map((value, index) => {
      const step = asRecord(value)
      const fallback = deterministicTools[index] ?? deterministicTools.at(-1)
      const fallbackContract = fallback?.contract ?? selected
      const fallbackTool = fallback?.tool ?? `${fallbackContract.agents[0] ?? 'agent_sem'}.wait`
      const rawSkill = stringOr(step.skill, fallbackContract.skill_id)
      const skill = expandedSkillIds.has(rawSkill) ? rawSkill : fallbackContract.skill_id
      const fallbackParts = splitFullToolName(fallbackTool, fallbackContract.agents[0] ?? 'agent_sem')
      const toolNameText = stringOr(step.tool_name, fallbackParts[1])
      const toolNameParts = splitFullToolName(toolNameText, stringOr(step.agent, fallbackParts[0]))
      const rawAgent = toolNameText.includes('.') ? toolNameParts[0] : stringOr(step.agent, fallbackParts[0])
      const rawToolName = toolNameParts[1]
      const fullTool = `${rawAgent}.${rawToolName}`
      const allowed = toolsBySkillAndName.get(`${skill}:${fullTool}`)
      const [agent, toolName] = allowed !== undefined ? [rawAgent, rawToolName] : splitFullToolName(fallbackTool, fallbackContract.agents[0] ?? 'agent_sem')
      const contractForStep = allowed?.contract ?? fallbackContract
      const baseArguments = asRecord(step.arguments)
      const plannedArguments = {
        ...baseArguments,
        ...contractForStep.skill_id === 'ptychography' && agent === 'agent_ptychography' && toolName === 'start_server_ptychography' && !Object.hasOwn(baseArguments, 'param_path')
          ? { param_path: '{{save_params.param_path}}' }
          : {},
      }
      return {
        step_id: stringOr(step.step_id, String(index + 1)),
        agent,
        goal: stringOr(step.goal, goalForTool(contractForStep, toolName)),
        skill: contractForStep.skill_id,
        tool_name: toolName,
        arguments: plannedArguments,
        required_inputs: arrayOfStrings(step.required_inputs),
        expected_output: stringOr(step.expected_output, `The ${agent}.${toolName} step completes and returns a concrete status/result.`),
        on_success: stringOr(step.on_success, String(index + 2)),
        on_failure: stringOr(step.on_failure, 'ask_user'),
      }
    })
    const finalSteps = steps.length > 0 ? steps : expanded.flatMap((contract, contractIndex) => {
      const tools = contract.ordered_tools.length > 0 ? contract.ordered_tools : contract.required_tools
      return tools.map((tool, toolIndex) => {
        const [agent, toolName] = splitFullToolName(tool, contract.agents[0] ?? 'agent_sem')
        const stepNumber = contractIndex + toolIndex + 1
        return {
          step_id: String(stepNumber),
          agent,
          goal: goalForTool(contract, toolName),
          skill: contract.skill_id,
          tool_name: toolName,
          arguments: {},
          required_inputs: [],
          expected_output: `The ${agent}.${toolName} step completes and returns a concrete status/result.`,
          on_success: String(stepNumber + 1),
          on_failure: 'ask_user',
        }
      })
    })
    const normalizedSteps = finalSteps.map((step, index, all) => ({
      ...step,
      step_id: String(index + 1),
      required_inputs: requiredInputsForStep(step.skill, step.agent, step.tool_name, all[index - 1]),
      on_success: index === all.length - 1 ? 'done' : String(index + 2),
    }))
    return {
      workflow_id: workflowId,
      ...sessionId === undefined ? {} : { session_id: sessionId },
      ...parentReturn === undefined ? {} : { parent_return: parentReturn },
      prompt,
      status: 'needs_approval',
      goal: stringOr(raw.goal, prompt),
      summary: stringOr(raw.summary, `Use the ${selected.name} skill workflow.`),
      steps: normalizedSteps,
      user_summary: stringOr(raw.user_summary, `I prepared a skill-grounded plan for ${selected.name}.`),
      missing_inputs: arrayOfStrings(raw.missing_inputs),
      risks: mergeUnique([
        ...arrayOfStrings(raw.risks),
        'Hardware-changing and acquisition/server-submission steps require explicit approval and step-level confirmation gates.',
      ]),
      judge_report: emptyJudgeReport(),
      judge_replan_history: previousPlan === undefined ? [] : [`Revised previous pending plan ${previousPlan.workflow_id}.`],
    }
  }

  private async selectSkill(prompt: string, previousPlan?: PendingPlan): Promise<SkillContract> {
    if (previousPlan !== undefined) {
      const contracts = await this.loadSkillContracts()
      const first = previousPlan.steps[0]?.skill
      const current = first === undefined ? undefined : contracts.get(first)
      if (current !== undefined && !/\b(new|fresh|重新|新的|从头)\b/i.test(prompt)) return current
    }
    const contracts = await this.loadSkillContracts()
    const candidates = [...contracts.values()]
    const normalized = prompt.toLowerCase().replace(/_/g, '-')
    const scored = candidates.map(contract => ({
      contract,
      score:
        scoreText(normalized, contract.skill_id.replace(/_/g, '-')) * 6
        + scoreText(normalized, contract.name) * 3
        + scoreText(normalized, contract.required_tools.join(' ')),
    })).sort((a, b) => b.score - a.score || a.contract.skill_id.localeCompare(b.contract.skill_id))
    if (scored[0]?.score && scored[0].score > 0) return scored[0].contract
    const fallback = contracts.get('ptychography') ?? candidates[0]
    if (fallback === undefined) throw new Error('No EDMORE skills are available for planning.')
    return fallback
  }

  private async loadSkillContracts(): Promise<Map<string, SkillContract>> {
    const contracts = new Map<string, SkillContract>()
    let entries: string[] = []
    try {
      entries = await readdir(this.skillsRoot)
    } catch {
      return contracts
    }
    for (const entry of entries) {
      try {
        const raw = JSON.parse(await readFile(join(this.skillsRoot, entry, 'manifest.json'), 'utf8')) as Record<string, unknown>
        const id = stringOr(raw.id, entry.replace(/-/g, '_'))
        contracts.set(id, {
          skill_id: id,
          name: stringOr(raw.name, id),
          agents: arrayOfStrings(raw.agents),
          required_tools: arrayOfStrings(raw.required_tools),
          optional_tools: arrayOfStrings(raw.optional_tools),
          ordered_tools: arrayOfStrings(raw.ordered_tools),
          references: arrayOfStrings(raw.references),
        })
      } catch {
        continue
      }
    }
    return contracts
  }

  private expandSkill(skillId: string, contracts: Map<string, SkillContract>, seen = new Set<string>()): SkillContract[] {
    if (seen.has(skillId)) return []
    seen.add(skillId)
    const contract = contracts.get(skillId)
    if (contract === undefined) return []
    if (contract.references.length === 0) return [contract]
    return contract.references.flatMap(ref => this.expandSkill(ref, contracts, seen))
  }

  private candidateSkillContracts(selected: SkillContract, expanded: SkillContract[], contracts: Map<string, SkillContract>): SkillContract[] {
    const ordered = new Map<string, SkillContract>()
    ordered.set(selected.skill_id, selected)
    for (const contract of expanded) ordered.set(contract.skill_id, contract)
    for (const contract of contracts.values()) ordered.set(contract.skill_id, contract)
    return [...ordered.values()]
  }

  private async defaultArguments(agent: string, toolName: string): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {}
    try {
      const listing = await this.nionSwift.listTools(agent) as { tools?: Array<{ name?: string; inputSchema?: Record<string, unknown> }> }
      const spec = (listing.tools ?? []).find(tool => tool.name === toolName)
      const schema = spec?.inputSchema ?? {}
      const properties = asRecord(schema.properties)
      const required = Array.isArray(schema.required) ? schema.required.map(String) : []
      for (const key of required) {
        const argSchema = asRecord(properties[key])
        args[key] = defaultValueForSchema(argSchema)
      }
    } catch {
      return args
    }
    return args
  }

  private async autoRepairAndJudge(inputPlan: PendingPlan): Promise<PendingPlan> {
    let plan = inputPlan
    const history: string[] = [...plan.judge_replan_history]
    const maxRepairAttempts = Math.max(0, Math.floor(this.autoRepairMaxAttempts))
    for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
      const deterministicReport = await this.judgePlan(plan)
      const report = await this.semanticJudgePlan(plan, deterministicReport)
      plan = { ...plan, judge_report: report, judge_replan_history: history }
      if (report.status === 'pass') return plan
      if (!isFixableJudgeReport(report) || attempt >= maxRepairAttempts) return plan
      history.push(`Auto-replan #${attempt + 1}: ${report.summary}`)
      await this.hub.append(withOptionalSession({
        type: 'edmore.plan.replan_requested',
        source: 'edmore-plan-judge',
        scope: 'workflow',
        workflow_id: plan.workflow_id,
        payload: {
          attempt: attempt + 1,
          max_attempts: maxRepairAttempts,
          summary: report.summary,
          issues: report.issues,
          history: history.slice(),
        },
      }, plan.session_id))
      plan = await this.repairPlan(plan, report)
    }
    return plan
  }

  private async semanticJudgePlan(plan: PendingPlan, deterministicReport: PlanJudgeReport): Promise<PlanJudgeReport> {
    if (this.roleRunner === undefined) return deterministicReport
    try {
      const authoritativeContext = await this.formatJudgeAuthorityContext(plan)
      const text = await this.roleRunner.runRoleOnce(plan.session_id ?? 'default', 'judge', [
        'You are the EDMORE judge agent.',
        'Review the proposed PlanReview and the deterministic judge report.',
        'Return only JSON with this exact shape:',
        JSON.stringify({
          status: 'pass | revise | block',
          summary: 'short reason',
          issues: [{
            severity: 'info | warning | blocking',
            category: 'grounding | skill | order | agent | tool | parameter',
            step_id: 'optional step id',
            skill: 'optional skill id',
            message: 'issue text',
          }],
        }, null, 2),
        '',
        'Rules:',
        '- You may downgrade a deterministic pass to revise or block if the plan is semantically unsafe, incomplete, or missing user gates.',
        '- You must not upgrade deterministic revise/block to pass.',
        '- Do not execute tools.',
        '- Every PlanReview is globally held for user approval before execution by the EDMORE workflow plugin.',
        '- optional_tools are available support tools, not mandatory plan steps. Do not demand their use when the skill instructions make them optional.',
        '- Only require confirmations explicitly requested by the skill instructions or an actual runtime error; do not invent additional gates for ordinary approved steps.',
        '- A conditional recovery offer is not an executable branch. The runtime pauses on a blocker, proposes a child-plan approach, waits for agreement, generates and judges the child plan, then requires approval before execution and returns to the saved parent step.',
        '- Do not require speculative child-plan steps in the initial parent plan when the skill explicitly defers recovery until a runtime failure. Check the supporting skill instructions for tools, outputs, and return behavior. Block any claim to execute an unreviewed branch automatically.',
        '- Step-level required_inputs are explicit user gates. Do not report a missing approval gate when a hardware-changing step already lists a confirmation in required_inputs.',
        '- Missing microscope parameters may be acceptable when the same step lists those parameter names in required_inputs; that means the approved workflow will pause and ask the user before calling the tool.',
        '- The deterministic judge has already checked exact registered skill ids, MCP agents, MCP tool names, and MCP tool parameter schemas.',
        '- Treat the authoritative skill contracts and MCP schemas below as ground truth. Do not report skill-name or parameter-name mismatch if they are valid there.',
        '- If you disagree with deterministic schema validation, mark it as info and explain the uncertainty; do not block on guessed alternative names.',
        '',
        `Authoritative skill/tool context:\n${authoritativeContext}`,
        '',
        `PlanReview:\n${JSON.stringify(plan, null, 2)}`,
        '',
        `Deterministic judge report:\n${JSON.stringify(deterministicReport, null, 2)}`,
      ].join('\n'), {
        event_id: plan.workflow_id,
        cursor: 0,
        timestamp: new Date().toISOString(),
        source: 'edmore-plan-judge',
        type: 'edmore.plan.judged',
        scope: 'workflow',
        ...plan.session_id === undefined ? {} : { session_id: plan.session_id },
        workflow_id: plan.workflow_id,
        payload: deterministicReport,
      }, {
        hidden: true,
        source: 'edmore-judge-agent',
      })
      const raw = asRecord(parseJsonObjectFromText(text))
      const judgeStatus = normalizeJudgeStatus(raw.status)
      const forcedStatus = deterministicReport.status === 'pass'
        ? judgeStatus
        : deterministicReport.status
      const rawIssues = Array.isArray(raw.issues) ? raw.issues : []
      const semanticIssues = rawIssues.map(normalizeJudgeIssue).filter((issue): issue is PlanJudgeIssue => issue !== undefined)
      return sanitizeSemanticJudgeReport(
        plan,
        deterministicReport,
        forcedStatus,
        stringOr(raw.summary, deterministicReport.summary),
        semanticIssues,
      )
    } catch (error) {
      return {
        ...deterministicReport,
        issues: [
          ...deterministicReport.issues,
          {
            severity: 'warning',
            category: 'grounding',
            message: `Judge agent did not return a usable semantic verdict: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      }
    }
  }

  private async formatJudgeAuthorityContext(plan: PendingPlan): Promise<string> {
    const contracts = await this.loadSkillContracts()
    const skillIds = [...new Set(plan.steps.map(step => step.skill))]
    const skills = skillIds.map(skillId => contracts.get(skillId)).filter((contract): contract is SkillContract => contract !== undefined)
    const agents = [...new Set(plan.steps.map(step => step.agent))]
    const tools: Record<string, Record<string, unknown>> = {}
    for (const agent of agents) {
      try {
        const listing = await this.nionSwift.listTools(agent) as { tools?: Array<{ name?: string; inputSchema?: Record<string, unknown> }> }
        tools[agent] = {}
        for (const tool of listing.tools ?? []) {
          if (typeof tool.name !== 'string') continue
          if (!plan.steps.some(step => step.agent === agent && step.tool_name === tool.name)) continue
          const schema = tool.inputSchema ?? {}
          const properties = asRecord(schema.properties)
          tools[agent][tool.name] = {
            parameters: Object.keys(properties),
            required: Array.isArray(schema.required) ? schema.required.map(String) : [],
          }
        }
      } catch {
        tools[agent] = { unavailable: true }
      }
    }
    return JSON.stringify({
      registered_skills: skills,
      supporting_skills: [...contracts.values()].filter(contract => !skillIds.includes(contract.skill_id)),
      skill_instructions: await this.renderSkillInstructions([...contracts.values()]),
      plan_tool_schemas: tools,
      deterministic_status: 'authoritative for exact ids, tools, and parameter schemas',
    }, null, 2)
  }

  private async repairPlan(plan: PendingPlan, report: PlanJudgeReport): Promise<PendingPlan> {
    let steps = plan.steps
    const parameterIssues = report.issues.filter(issue => issue.category === 'parameter')
    if (parameterIssues.length > 0) {
      steps = await Promise.all(steps.map(async (step) => {
        const listing = await this.nionSwift.listTools(step.agent).catch(() => undefined) as { tools?: Array<{ name?: string; inputSchema?: Record<string, unknown> }> } | undefined
        const spec = (listing?.tools ?? []).find(tool => tool.name === step.tool_name)
        const schema = spec?.inputSchema ?? {}
        const properties = asRecord(schema.properties)
        const required = Array.isArray(schema.required) ? schema.required.map(String) : []
        const nextArgs: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(step.arguments)) {
          if (Object.hasOwn(properties, key)) nextArgs[key] = value
        }
        for (const key of required) {
          if (!Object.hasOwn(nextArgs, key)) nextArgs[key] = defaultValueForSchema(asRecord(properties[key]))
        }
        return { ...step, arguments: nextArgs }
      }))
    }
    return { ...plan, steps }
  }

  private async judgePlan(plan: PendingPlan): Promise<PlanJudgeReport> {
    const contracts = await this.loadSkillContracts()
    const status = await this.nionSwift.status()
    const availableAgents = new Set(status.ok ? status.agents : [])
    const issues: PlanJudgeIssue[] = []
    const groundedSequences = new Map<string, string[]>()
    let groundedSteps = 0
    const toolsByAgent = new Map<string, Map<string, { inputSchema?: Record<string, unknown> }>>()

    const toolSpecs = async (agent: string): Promise<Map<string, { inputSchema?: Record<string, unknown> }>> => {
      const cached = toolsByAgent.get(agent)
      if (cached !== undefined) return cached
      const listing = await this.nionSwift.listTools(agent).catch(() => ({ tools: [] })) as { tools?: Array<{ name?: string; inputSchema?: Record<string, unknown> }> }
      const specs = new Map<string, { inputSchema?: Record<string, unknown> }>()
      for (const tool of listing.tools ?? []) {
        if (typeof tool.name !== 'string') continue
        specs.set(tool.name, {
          ...tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema },
        })
      }
      toolsByAgent.set(agent, specs)
      return specs
    }

    for (const step of plan.steps) {
      const contract = contracts.get(step.skill)
      const fullToolName = `${step.agent}.${step.tool_name}`
      if (contract === undefined) {
        issues.push(issue('skill', `Skill '${step.skill}' does not exist in the registered Harness skills.`, step))
      } else if (![...contract.required_tools, ...contract.optional_tools].includes(fullToolName)) {
        issues.push(issue('grounding', `Step uses tool '${fullToolName}' which is not declared in skill '${step.skill}'.`, step))
      } else {
        groundedSteps += 1
        const sequence = groundedSequences.get(step.skill) ?? []
        sequence.push(fullToolName)
        groundedSequences.set(step.skill, sequence)
      }

      if (!availableAgents.has(step.agent)) {
        issues.push(issue('agent', `Step references unavailable agent '${step.agent}'.`, step))
        continue
      }
      const specs = await toolSpecs(step.agent)
      const spec = specs.get(step.tool_name)
      if (spec === undefined) {
        issues.push(issue('tool', `Step references unavailable tool '${fullToolName}'.`, step))
        continue
      }
      const schema = spec.inputSchema ?? {}
      const properties = asRecord(schema.properties)
      const required = Array.isArray(schema.required) ? schema.required.map(String) : []
      for (const key of required) {
        if (!Object.hasOwn(step.arguments, key) && !requiredInputCovers(step.required_inputs, key)) {
          issues.push(issue('parameter', `Missing required parameter '${key}' for tool '${fullToolName}'.`, step))
        }
      }
      for (const [argName, argValue] of Object.entries(step.arguments)) {
        if (isPlaceholder(argValue)) continue
        if (argValue === null && requiredInputCovers(step.required_inputs, argName)) continue
        if (Object.keys(properties).length > 0 && !Object.hasOwn(properties, argName)) {
          issues.push(issue('parameter', `Unexpected parameter '${argName}' for tool '${fullToolName}'.`, step))
          continue
        }
        const argSchema = asRecord(properties[argName])
        if (Object.keys(argSchema).length > 0 && !schemaAcceptsType(argSchema, argValue)) {
          issues.push(issue('parameter', `Parameter '${argName}' has value '${String(argValue)}' that does not match the MCP schema for '${fullToolName}'.`, step))
        }
      }
    }

    for (const [skillId, sequence] of groundedSequences) {
      const contract = contracts.get(skillId)
      const ordered = contract?.ordered_tools ?? []
      const coreSequence = sequence.filter(tool => !contract?.optional_tools.includes(tool))
      if (ordered.length > 0 && !isSubsequence(coreSequence, ordered)) {
        issues.push({ severity: 'blocking', category: 'order', skill: skillId, message: `Plan steps for skill '${skillId}' do not follow the tool order declared in the skill contract.` })
      }
    }

    const grounding_status = groundedSteps === plan.steps.length && groundedSteps > 0
      ? 'fully_grounded'
      : groundedSteps > 0 ? 'partially_grounded' : 'ungrounded'
    const blocking = issues.some(item => item.severity === 'blocking')
    const statusValue = grounding_status === 'fully_grounded' && !blocking
      ? 'pass'
      : grounding_status === 'partially_grounded' ? 'revise' : 'block'
    const summary = statusValue === 'pass'
      ? 'Plan is fully grounded in registered skills and passed deterministic MCP tool/schema validation.'
      : statusValue === 'revise'
        ? 'Plan is only partially grounded in registered skills and needs revision before approval.'
        : `Plan is not sufficiently grounded or required agents/tools are unavailable. Visible agents: ${status.ok ? status.agents.join(', ') || 'none' : status.message}.`
    return { grounding_status, status: statusValue, summary, issues }
  }

  private formatPlanAwaitingApproval(plan: PendingPlan): string {
    const rows = plan.steps.map(step => [
      `${step.step_id}. ${step.agent}.${step.tool_name}`,
      `   ${step.goal}`,
      step.required_inputs.length ? `   Gate: ${step.required_inputs.join('; ')}` : '',
    ].filter(Boolean).join('\n'))
    return [
      'Plan review required before execution.',
      '',
      `Goal: ${plan.goal}`,
      `Summary: ${plan.summary}`,
      '',
      ...rows,
      '',
      "Reply 'approve' or press Approve to execute this plan. Tell me what to change to revise it.",
    ].join('\n')
  }

  private formatStepLoopPrompt(
    plan: PendingPlan,
    stepIndex: number,
    step: PlanStep,
    resume?: {
      userMessage: string
      pauseReason: string
      pauseState: Record<string, unknown>
      confirmationContext?: unknown
    },
  ): string {
    const current = {
      step_index: stepIndex,
      step_id: step.step_id,
      skill: step.skill,
      goal: step.goal,
      tool: nionSwiftHarnessToolName(step.agent, step.tool_name),
      raw_agent: step.agent,
      raw_tool_name: step.tool_name,
      arguments: step.arguments,
      required_inputs: step.required_inputs,
      expected_output: step.expected_output,
      on_success: step.on_success,
      on_failure: step.on_failure,
    }
    return [
      'You are executing one step of an approved EDMORE PlanReview inside Harness.',
      'Execute exactly the current_step below, then stop. Do not call any other NionSwift MCP tool in this turn.',
      'Do not ask for additional confirmation beyond the skill gates in required_inputs. Unknown optional arguments can use tool/UI defaults. Report actual tool errors instead of asking for speculative confirmation.',
      'Do not create a new plan. Do not reorder steps. The EDMORE plan-judge-loop plugin will enforce the approved step and arguments.',
      'If the current step is blocked by a required user confirmation/input, stop and tell the user what is needed.',
      '',
      `Execution role: ${executorRoleForMcpAgent(step.agent)}`,
      `Workflow id: ${plan.workflow_id}`,
      '',
      resume === undefined ? '' : `User gate reply:\n${resume.userMessage}`,
      resume === undefined ? '' : '',
      resume?.confirmationContext === undefined ? '' : `NionSwift confirmation context:\n${JSON.stringify(resume.confirmationContext, null, 2)}`,
      resume?.confirmationContext === undefined ? '' : '',
      resume === undefined ? '' : `Previous pause reason:\n${resume.pauseReason}`,
      resume === undefined ? '' : '',
      resume === undefined ? '' : `Previous pause state:\n${JSON.stringify(resume.pauseState, null, 2)}`,
      resume === undefined ? '' : '',
      `Current approved step:\n${JSON.stringify(current, null, 2)}`,
      '',
      `Full approved plan for context:\n${this.formatLoopPlan(plan)}`,
    ].filter(line => line.length > 0).join('\n')
  }

  private formatLoopPlan(plan: PendingPlan): string {
    const steps = plan.steps.map(step => ({
      step_id: step.step_id,
      skill: step.skill,
      goal: step.goal,
      tool: nionSwiftHarnessToolName(step.agent, step.tool_name),
      raw_agent: step.agent,
      raw_tool_name: step.tool_name,
      arguments: step.arguments,
      required_inputs: step.required_inputs,
      expected_output: step.expected_output,
      on_success: step.on_success,
      on_failure: step.on_failure,
    }))
    return JSON.stringify({
      workflow_id: plan.workflow_id,
      goal: plan.goal,
      summary: plan.summary,
      judge_report: plan.judge_report,
      steps,
    }, null, 2)
  }

  private sessionIdForHarnessAgent(harnessSessionId: string | undefined): string | undefined {
    if (harnessSessionId === undefined) return undefined
    return this.sessionByHarnessAgent.get(harnessSessionId)
      ?? (harnessSessionId.startsWith('edmore-') ? harnessSessionId.slice('edmore-'.length) : undefined)
  }

  private async emitAssistantMessage(event: EdmoreEvent, text: string): Promise<void> {
    await this.emitAssistantText(event.session_id, event.event_id, text)
  }

  private async emitAssistantText(sessionId: string | undefined, correlationId: string | undefined, text: string): Promise<void> {
    const responseId = randomUUID()
    await this.hub.append(withOptionalSession({
      type: 'edmore.assistant.started',
      source: 'edmore-plan-judge',
      scope: 'workflow',
      ...correlationId === undefined ? {} : { correlation_id: correlationId },
      payload: { response_id: responseId },
    }, sessionId))
    await this.hub.append(withOptionalSession({
      type: 'edmore.assistant.completed',
      source: 'edmore-plan-judge',
      scope: 'workflow',
      ...correlationId === undefined ? {} : { correlation_id: correlationId },
      payload: {
        response_id: responseId,
        text,
      },
    }, sessionId))
  }
}

export function contentText(content: ContentBlock[]): string {
  const parts = content.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return block.text
    if (block.type === 'tool-call') return `${block.name}(${block.arguments})`
    if (block.type === 'tool-result') return contentText(block.content)
    return `[${block.type}]`
  })
  return parts.join('\n').trim()
}

export function projectMcpContent(content: unknown[], toolName: string): ContentBlock[] {
  const text: string[] = []
  for (const value of content) {
    const block = asRecord(value)
    const type = typeof block.type === 'string' ? block.type : 'unknown'
    if (type === 'text') {
      if (typeof block.text === 'string') text.push(block.text)
      continue
    }
    if (type === 'resource_link') {
      const uri = typeof block.uri === 'string' ? block.uri : ''
      const name = typeof block.name === 'string' ? block.name : uri
      text.push(uri ? `[resource link: ${name}] ${uri}` : `[resource link: ${name}]`)
      continue
    }
    if (type === 'resource') {
      const resource = asRecord(block.resource)
      const uri = typeof resource.uri === 'string' ? resource.uri : ''
      const resourceText = typeof resource.text === 'string' ? resource.text : ''
      text.push(resourceText || (uri ? `[resource: ${uri}]` : '[resource result]'))
      continue
    }
    if (type === 'image') {
      const mime = typeof block.mimeType === 'string' ? block.mimeType : 'image'
      text.push(`[${mime} result omitted from text view]`)
      continue
    }
    if (type === 'audio') {
      const mime = typeof block.mimeType === 'string' ? block.mimeType : 'audio'
      text.push(`[${mime} result omitted from text view]`)
      continue
    }
    text.push(`[unsupported MCP content type: ${type}]`)
  }
  return text.length > 0 ? [{ type: 'text', text: text.join('\n') }] : [{ type: 'text', text: `(${toolName} returned no model-visible content)` }]
}

function scoreText(haystack: string, needle: string): number {
  const normalizedHaystack = haystack.toLowerCase().replace(/_/g, '-')
  return needle.toLowerCase().replace(/_/g, '-').split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3)
    .reduce((score, token) => score + (normalizedHaystack.includes(token) ? 1 : 0), 0)
}

function splitFullToolName(value: string, fallbackAgent: string): [string, string] {
  const raw = value.trim()
  const index = raw.indexOf('.')
  if (index > 0) return [raw.slice(0, index), raw.slice(index + 1)]
  return [fallbackAgent, raw]
}

export function nionSwiftHarnessToolName(agent: string, rawToolName: string): string {
  const serverName = `nionswift_${agent}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  return publicToolName(serverName, rawToolName)
}

function goalForTool(contract: SkillContract, toolName: string): string {
  return `${contract.name}: run ${toolName.replace(/_/g, ' ')}.`
}

export function requiredInputsForStep(skill: string, agent: string, toolName: string, previousStep?: PlanStep): string[] {
  const full = `${agent}.${toolName}`
  const previousFull = previousStep === undefined ? '' : `${previousStep.agent}.${previousStep.tool_name}`
  if (skill === 'acquire_4d_stem' && full === 'agent_sem.wait' && previousFull === 'agent_sem.sync_pixel_size') {
    return [
      'confirm_roi_selection_after_pixel_sync',
      'confirm the synchronized ROI/scan geometry before stopping preview',
    ]
  }
  if (skill === 'ptychography' && full === 'agent_ptychography.append_exp_params') {
    return ['confirm_prepared_ptychography_parameters']
  }
  if (skill === 'ptychography' && full === 'agent_ptychography.start_server_ptychography') {
    return ['confirm_saved_ptychography_parameters_before_server']
  }
  if (skill === 'recommend_4d_stem_parameters' && full === 'agent_suggestion.update_parameters') {
    return [
      'recommendation_settings_confirmation',
      'confirm or no changes to accept settings; otherwise reply with specific parameter changes',
    ]
  }
  return []
}

function defaultValueForSchema(schema: Record<string, unknown>): unknown {
  if (schemaAcceptsType(schema, null)) return null
  const type = schema.type
  if (type === 'array') return []
  if (type === 'object') return {}
  if (type === 'string') return ''
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false
  if (Array.isArray(type)) {
    if (type.includes('null')) return null
    if (type.includes('array')) return []
    if (type.includes('object')) return {}
    if (type.includes('string')) return ''
    if (type.includes('integer') || type.includes('number')) return 0
    if (type.includes('boolean')) return false
  }
  return null
}

function schemaAcceptsType(schema: Record<string, unknown>, value: unknown): boolean {
  for (const unionKey of ['anyOf', 'oneOf']) {
    const options = schema[unionKey]
    if (Array.isArray(options) && options.length > 0) {
      return options.some(option => typeof option === 'object' && option !== null && schemaAcceptsType(option as Record<string, unknown>, value))
    }
  }
  const schemaType = schema.type
  if (Array.isArray(schemaType)) return schemaType.some(one => schemaAcceptsType({ type: one }, value))
  if (value === null) return schemaType === undefined || schemaType === 'null'
  if (schemaType === undefined || schemaType === 'any') return true
  if (schemaType === 'string') return typeof value === 'string'
  if (schemaType === 'integer') return Number.isInteger(value)
  if (schemaType === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (schemaType === 'boolean') return typeof value === 'boolean'
  if (schemaType === 'array') return Array.isArray(value)
  if (schemaType === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value)
  return true
}

function isPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('{{') && value.trim().endsWith('}}')
}

function requiredInputCovers(requiredInputs: string[], key: string): boolean {
  const normalizedKey = key.toLowerCase()
  return requiredInputs.some(input => input.toLowerCase().includes(normalizedKey))
}

function instrumentIdsForPlan(plan: PendingPlan): string[] {
  const ids = new Set<string>()
  if (plan.steps.some(step => step.agent === 'agent_sem')) ids.add('nionswift:sem')
  return [...ids]
}

function mcpResultLooksFailed(result: Record<string, unknown>, text: string): boolean {
  if (result.isError === true) return true
  const normalized = text.trim().toLowerCase()
  return /^([\w -]+ )?failed\b/.test(normalized)
    || normalized.includes(' failed:')
    || normalized.includes(' error:')
}

function isSubsequence(sequence: string[], ordered: string[]): boolean {
  if (sequence.length === 0) return false
  let index = 0
  for (const item of ordered) {
    if (sequence[index] === item) index += 1
  }
  return index === sequence.length
}

function issue(category: PlanJudgeIssue['category'], message: string, step: PlanStep): PlanJudgeIssue {
  return {
    severity: 'blocking',
    category,
    step_id: step.step_id,
    skill: step.skill,
    message,
  }
}

function emptyJudgeReport(): PlanJudgeReport {
  return {
    grounding_status: 'ungrounded',
    status: 'block',
    summary: '',
    issues: [],
  }
}

function isFixableJudgeReport(report: PlanJudgeReport): boolean {
  if (report.grounding_status === 'ungrounded') return false
  const blocking = report.issues.filter(issue => issue.severity === 'blocking')
  if (blocking.length === 0) return false
  return blocking.every(issue => issue.category === 'order' || issue.category === 'parameter' || issue.category === 'grounding')
}

function stepFromPausedState(state: Record<string, unknown>): PlanStep {
  const stepId = stringOr(state.step_id, 'paused')
  const agent = stringOr(state.agent, 'unknown')
  const toolName = stringOr(state.tool_name, 'unknown')
  const requiredInputs = Array.isArray(state.required_inputs)
    ? state.required_inputs.map(item => String(item))
    : []
  return {
    step_id: stepId,
    agent,
    goal: stringOr(state.goal, `Resume paused step ${stepId}`),
    skill: stringOr(state.skill, 'unknown'),
    tool_name: toolName,
    arguments: {},
    required_inputs: requiredInputs,
    expected_output: '',
    on_success: '',
    on_failure: 'ask_user',
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map(item => item.trim()).filter(Boolean) : []
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter(record => Object.keys(record).length > 0) : []
}

function withOptionalSession<T extends Omit<Partial<EdmoreEvent>, 'event_id' | 'cursor' | 'timestamp'> & Pick<EdmoreEvent, 'type'>>(
  event: T,
  sessionId: string | undefined,
): T {
  return sessionId === undefined ? event : { ...event, session_id: sessionId }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isLegacyNionSwiftTrigger(event: EdmoreEvent): boolean {
  if (event.source !== 'nionswift-mcp') return false
  const payload = asRecord(event.payload)
  const targets = payload.targets
  const hasTriggerTarget = Array.isArray(targets) && targets.includes('trigger')
  return event.type === 'edmore.custom.trigger_llm'
    || payload.event_type === 'trigger_llm'
    || (payload.event_type === 'tool_call' && hasTriggerTarget)
}

function legacyNionSwiftFields(event: EdmoreEvent): Record<string, string> {
  const payload = asRecord(event.payload)
  const toolCallMessage = asRecord(payload.tool_call_message)
  const toolResultsMessage = asRecord(payload.tool_results_message)
  const toolStatus = asRecord(payload.tool_status)

  return {
    agent: textOf(payload.agent),
    trigger: textOf(payload.trigger) || textOf(toolCallMessage.trigger_message) || textOf(payload.message),
    toolOutput: textOf(payload.tool_output) || textOf(toolResultsMessage.output) || textOf(toolStatus.message),
    toolName: textOf(payload.tool_name) || textOf(toolCallMessage.name) || textOf(toolStatus.tool_name),
    status: textOf(payload.status) || textOf(toolStatus.status),
    requiredInputs: textOf(payload.required_inputs) || textOf(toolStatus.required_inputs),
    error: textOf(payload.error) || textOf(toolStatus.error),
    uiActionContext: textOf(payload.ui_action_context),
  }
}

function isLegacyWorkflowConfirmation(event: EdmoreEvent): boolean {
  if (!isLegacyNionSwiftTrigger(event)) return false
  const fields = legacyNionSwiftFields(event)
  const haystack = [
    fields.toolName,
    fields.trigger,
    fields.status,
    fields.toolOutput,
    fields.uiActionContext,
  ].join('\n').toLowerCase()
  return /\bconfirm(ed|ation|_roi| roi)?\b/.test(haystack) || /roi selection confirmed/.test(haystack)
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}
