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

export interface RoleRunOptions {
  isolated?: boolean
  hidden?: boolean
  source?: string
}

export interface EventFilter {
  after?: number
  scope?: string
  session_id?: string
  workflow_id?: string
  server_id?: string
  limit?: number
}

export interface RuntimeDispatch {
  executionId?: string
  retryPrompt?: string
  retryToolName?: string
  argumentRepairAttempt?: number
  workflowId: string
  role: string
  prompt: string
  step: { step_id: string; agent: string; tool_name: string }
}

export interface RuntimeScheduler {
  bindSession(harnessSessionId: string, sessionId: string): void
  next(sessionId: string, workflowId: string): RuntimeDispatch | undefined
  pauseEmptyOutput?(sessionId: string, dispatch: RuntimeDispatch, correlationId: string, reason: string): Promise<boolean>
}

export interface ToolPolicy {
  beforeLoopToolCall(sessionId: string | undefined, agent: string, tool: string, args: Record<string, unknown>, callId: string): Promise<unknown>
  afterLoopToolResult(sessionId: string | undefined, agent: string, tool: string, callId: string, result: Record<string, unknown>): Promise<unknown>
  handleLoopToolError(sessionId: string | undefined, agent: string, tool: string, callId: string, error: unknown): Promise<unknown>
}

export interface McpConnection {
  status(): Promise<{ ok: boolean; agents: string[]; agentInfo: Record<string, { name: string; provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number }>; message: string }>
  listTools(agent: string): Promise<unknown>
  listResources(agent: string): Promise<unknown>
  readResource(agent: string, uri: string): Promise<unknown>
  callTool(agent: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>
}

export interface WorkflowDecision {
  action: 'chat' | 'planned' | 'blocked' | 'execute'
  message?: string
  executionPrompt?: string
  workflowId?: string
  role?: string
}

export interface WorkflowControl {
  state(): unknown
  routeSessionForLegacyTrigger(event: EdmoreEvent): string | undefined
  handleTrigger(event: EdmoreEvent): Promise<WorkflowDecision>
  approve(workflowId: string, sessionId?: string, correlationId?: string): Promise<WorkflowDecision>
  editTemporaryPlan?(workflowId: string, sessionId: string, draft: unknown): Promise<unknown>
  resume(workflowId: string | undefined, sessionId: string | undefined, prompt?: string, correlationId?: string, confirmationContext?: unknown): Promise<WorkflowDecision>
  reject(workflowId: string, reason?: string, sessionId?: string): Promise<void>
  cancelSession(sessionId: string): Promise<{ hardware_stop_verified: boolean }>
  cancelPaused(workflowId: string, sessionId: string, verifiedHardwareStopped: boolean): Promise<void>
}

export class CapabilityUnavailableError extends Error {
  readonly code = 'capability_unavailable'
  constructor(readonly capability: string, message: string) { super(message) }
}

export interface EvidenceEvent {
  event_id: string
  timestamp: string
  source: string
  type: string
  session_id?: string
  workflow_id?: string
  step_id?: string
  correlation_id?: string
  payload: unknown
}

export interface WorkflowEvidence {
  stepResult?(sessionId: string, workflowId: string, stepId: string): unknown
  record(event: EvidenceEvent): void
  flush(): Promise<void>
  evidence(sessionId: string, workflowIds: string[], through?: number): { version: number; digest: string; event_ids: string[]; [key: string]: unknown }
}
