import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ListResourcesResultSchema, ListToolsResultSchema, ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z as zod } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, AssistantStreamFrame, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import { isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { EdmoreWorkflow, RoleRunOptions } from '@deepseek-ai/dsh-edmore-plan-judge'
import { contentText, projectMcpContent } from '@deepseek-ai/dsh-edmore-plan-judge'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-edmore-plan-judge'

export const name = 'edmore-backend'
export const inject = ['webServer', 'agents', 'sessions', 'systemPrompt', 'tools', 'skills', 'edmorePlanJudge']

export interface Config {
  eventLogPath: string
  nionSwiftBaseUrl: string
  nionSwiftPollMs: number
  validationUiPath: string
  llmProviderStorePath: string
  agentRoleStorePath: string
  planJudgeStatePath: string
  planJudgeAutoRepairMaxAttempts: number
  assistantProvider: string
  assistantModel: string
  assistantReasoningEffort?: string
  assistantMaxTokens: number
  assistantTimeoutMs: number
}

export const Config: z<Config> = z.object({
  eventLogPath: z.string().required(),
  nionSwiftBaseUrl: z.string().default('http://127.0.0.1:7300'),
  nionSwiftPollMs: z.number().min(500).default(3000),
  validationUiPath: z.string().default('/edmore'),
  llmProviderStorePath: z.string().required(),
  agentRoleStorePath: z.string().required(),
  planJudgeStatePath: z.string().required(),
  planJudgeAutoRepairMaxAttempts: z.number().min(0).default(2),
  assistantProvider: z.string().default('openai'),
  assistantModel: z.string().default('gpt-5-mini'),
  assistantReasoningEffort: z.string(),
  assistantMaxTokens: z.number().min(1).default(4096),
  assistantTimeoutMs: z.number().min(1000).default(60000),
})

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

interface EventFilter {
  after?: number
  scope?: string
  session_id?: string
  workflow_id?: string
  server_id?: string
  limit?: number
}

interface EdmoreUiEvent {
  event_id: string
  cursor: number
  timestamp: string
  source: string
  type: string
  scope: 'ui'
  session_id?: string
  workflow_id?: string
  raw_event_id: string
  raw_cursor: number
  payload: Record<string, unknown>
}

interface AssistantConfig {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens: number
  timeoutMs: number
}

interface AgentRoleConfigInput {
  role?: unknown
  provider?: unknown
  model?: unknown
  reasoning_effort?: unknown
  reasoningEffort?: unknown
  max_tokens?: unknown
  maxTokens?: unknown
  timeout_ms?: unknown
  timeoutMs?: unknown
}

interface AgentRoleStore {
  roles?: Record<string, Partial<AssistantConfig>>
}

type AgentConfigSource = 'user_role' | 'mcp_agent' | 'backend_default'

interface ResolvedAgentConfig {
  config: AssistantConfig
  sources: Record<keyof AssistantConfig, AgentConfigSource>
}

interface NionSwiftAgentInfo {
  name: string
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

interface LlmProviderProfile {
  id: string
  displayName: string
  baseURL?: string
  model: string
  embeddingBaseURL?: string
  embeddingModel?: string
  apiKeyEnv?: string
  api?: string
  reasoningEffort?: string
  active?: boolean
}

interface LlmProviderStore {
  activeProvider?: string
  profiles?: LlmProviderProfile[]
}

interface LlmProviderInput {
  id?: unknown
  displayName?: unknown
  base_url?: unknown
  baseURL?: unknown
  model?: unknown
  embedding_base_url?: unknown
  embeddingBaseURL?: unknown
  embedding_model?: unknown
  embeddingModel?: unknown
  api_key?: unknown
  apiKey?: unknown
  api_key_env?: unknown
  apiKeyEnv?: unknown
  api?: unknown
  reasoning_effort?: unknown
  reasoningEffort?: unknown
}

const CORE_EVENTS = new Set([
  'edmore.server.started',
  'edmore.server.heartbeat',
  'edmore.server.stopped',
  'edmore.ui.show',
  'edmore.trigger.requested',
  'edmore.assistant.started',
  'edmore.assistant.delta',
  'edmore.assistant.completed',
  'edmore.assistant.failed',
  'edmore.llm.provider.updated',
  'edmore.llm.provider.selected',
  'edmore.conversation.title.requested',
  'edmore.conversation.title.generated',
  'edmore.conversation.title.failed',
  'edmore.conversation.updated',
  'edmore.plan.generated',
  'edmore.plan.judged',
  'edmore.plan.replan_requested',
  'edmore.approval.requested',
  'edmore.approval.granted',
  'edmore.approval.rejected',
  'edmore.workflow.started',
  'edmore.workflow.paused',
  'edmore.workflow.resumed',
  'edmore.workflow.completed',
  'edmore.workflow.failed',
  'edmore.hardware.observed',
  'edmore.instrument.status_changed',
])

const FORBIDDEN_CUSTOM_ACTIONS = new Set([
  'direct_hardware_move',
  'direct_acquire',
  'direct_beam_change',
  'move_stage',
  'start_acquisition',
])

const DEFAULT_LLM_PROVIDER_PROFILES: LlmProviderProfile[] = [
  {
    id: 'llm3-hu',
    displayName: 'HU LLM',
    baseURL: 'https://llm3-compute.cms.hu-berlin.de/v1',
    model: 'llm3',
    embeddingBaseURL: 'https://llm5-compute.cms.hu-berlin.de/v1',
    embeddingModel: 'llm5',
    apiKeyEnv: 'EDMORE_HU_LLM_API_KEY',
    api: 'openai-completions',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    model: 'gpt-5-mini',
    embeddingModel: 'text-embedding-3-small',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
]

const DEFAULT_AGENT_ROLE_CONFIGS: Record<string, Partial<AssistantConfig>> = {
  orchestrator: { reasoningEffort: 'low', maxTokens: 2048 },
  planner: { reasoningEffort: 'low', maxTokens: 4096 },
  judge: { reasoningEffort: 'low', maxTokens: 4096 },
  executor: { reasoningEffort: 'low', maxTokens: 2048 },
  title_generator: { reasoningEffort: 'low', maxTokens: 128 },
}

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

const RawCallToolResultSchema = zod.record(zod.string(), zod.unknown())

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function compactAssistantConfig(config: Record<string, unknown>): Partial<AssistantConfig> {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined && value !== '')) as Partial<AssistantConfig>
}

function normalizeNionSwiftAgentInfo(value: unknown): NionSwiftAgentInfo | undefined {
  if (typeof value === 'string') return { name: value }
  const raw = asRecord(value)
  const name = optionalString(raw.name) ?? optionalString(raw.id) ?? optionalString(raw.agent)
  if (name === undefined) return undefined
  const provider = optionalString(raw.provider) ?? optionalString(raw.llm_provider)
  const model = optionalString(raw.model) ?? optionalString(raw.llm_model)
  const reasoningEffort = optionalString(raw.reasoningEffort) ?? optionalString(raw.reasoning_effort)
  const maxTokensRaw = raw.maxTokens ?? raw.max_tokens
  const maxTokens = typeof maxTokensRaw === 'number' && Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
    ? Math.floor(maxTokensRaw)
    : undefined
  return {
    name,
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
    ...maxTokens === undefined ? {} : { maxTokens },
  }
}

function assistantConfigFromAgentInfo(info: NionSwiftAgentInfo | undefined): Partial<AssistantConfig> {
  return compactAssistantConfig({
    ...(info?.provider === undefined ? {} : { provider: info.provider }),
    ...(info?.model === undefined ? {} : { model: info.model }),
    ...(info?.reasoningEffort === undefined ? {} : { reasoningEffort: info.reasoningEffort }),
    ...(info?.maxTokens === undefined ? {} : { maxTokens: info.maxTokens }),
  })
}

function normalizeRoleId(role: string): string {
  return role.trim().toLowerCase().replace(/\s+/g, '_')
}

function baseRoleFor(role: string): string {
  return role.startsWith('executor:') ? 'executor' : role
}

function executorRoleForMcpAgent(agent: string): string {
  return `executor:${agent}`
}

function roleAllowsMcpAgent(role: string, agent: string): boolean {
  if (role === 'orchestrator') return true
  if (!role.startsWith('executor:')) return false
  return role.slice('executor:'.length) === agent
}

function allowedToolNamesForRole(role: string, availableNames: string[]): string[] | undefined {
  if (role === 'orchestrator') return undefined
  const baseAllow = availableNames.filter(name => name === 'skill' || name === 'list_subagent_models')
  if (!role.startsWith('executor:')) return baseAllow
  const agent = role.slice('executor:'.length)
  const prefix = `mcp__nionswift_${agent}__`
  return [...baseAllow, ...availableNames.filter(name => name.startsWith(prefix))]
}

function stringField(value: unknown, name: string): string {
  const text = optionalString(value)
  if (text === undefined) throw new Error(`${name} is required`)
  return text
}

function defaultCredentialRefForProvider(id: string): string {
  const upper = id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return `EDMORE_${upper}_API_KEY`
}

function credentialRefName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid credential ref: ${value}`)
  return value
}

function compactProfile(profile: LlmProviderProfile): LlmProviderProfile {
  return JSON.parse(JSON.stringify(profile)) as LlmProviderProfile
}

function settingsService(ctx: Context): {
  update(ns: string, patch: Record<string, unknown>): Promise<void>
  replace(ns: string, section: Record<string, unknown>): Promise<void>
} | undefined {
  return ctx.get('settings' as never) as {
    update(ns: string, patch: Record<string, unknown>): Promise<void>
    replace(ns: string, section: Record<string, unknown>): Promise<void>
  } | undefined
}

function credentialsService(ctx: Context): {
  describe(ref: string): Promise<unknown>
  set(ref: string, value: string): Promise<void>
} | undefined {
  return ctx.get('credentials' as never) as {
    describe(ref: string): Promise<unknown>
    set(ref: string, value: string): Promise<void>
  } | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    edmoreEvents: EdmoreEventHub
    edmoreWorkflow: EdmoreWorkflow
    edmoreNionSwift: NionSwiftBridge
    edmoreLlmProviders: EdmoreLlmProviderManager
    edmoreSkills: EdmoreSkillContext
    edmoreAgentLoop: EdmoreAgentLoopBridge
  }
}

class EdmoreEventHub {
  private events: EdmoreEvent[] = []
  private nextCursor = 1
  private subscribers = new Set<(event: EdmoreEvent) => void>()
  private loadPromise: Promise<void>
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private path: string) {
    this.loadPromise = this.load()
  }

  async ready(): Promise<void> {
    await this.loadPromise
  }

  async append(input: Omit<Partial<EdmoreEvent>, 'event_id' | 'cursor' | 'timestamp'> & Pick<EdmoreEvent, 'type'>): Promise<EdmoreEvent> {
    await this.ready()
    this.validate(input)
    const event: EdmoreEvent = {
      event_id: randomUUID(),
      cursor: this.nextCursor++,
      timestamp: new Date().toISOString(),
      source: input.source ?? 'edmore-harness',
      type: input.type,
      scope: input.scope ?? 'global',
      ...input.session_id === undefined ? {} : { session_id: input.session_id },
      ...input.workflow_id === undefined ? {} : { workflow_id: input.workflow_id },
      ...input.server_id === undefined ? {} : { server_id: input.server_id },
      ...input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id },
      payload: input.payload ?? {},
    }
    this.events.push(event)
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(this.path, `${this.events.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8')
    })
    await this.writeChain
    for (const subscriber of this.subscribers) subscriber(event)
    return event
  }

  query(filter: EventFilter = {}): EdmoreEvent[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
    const matches = this.events
      .filter(event => filter.after === undefined || event.cursor > filter.after)
      .filter(event => filter.scope === undefined || event.scope === filter.scope)
      .filter(event => filter.session_id === undefined || event.session_id === filter.session_id)
      .filter(event => filter.workflow_id === undefined || event.workflow_id === filter.workflow_id)
      .filter(event => filter.server_id === undefined || event.server_id === filter.server_id)
    return filter.after === undefined ? matches.slice(-limit) : matches.slice(0, limit)
  }

  subscribe(listener: (event: EdmoreEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => { this.subscribers.delete(listener) }
  }

  matches(event: EdmoreEvent, filter: EventFilter): boolean {
    return (filter.after === undefined || event.cursor > filter.after)
      && (filter.scope === undefined || event.scope === filter.scope)
      && (filter.session_id === undefined || event.session_id === filter.session_id)
      && (filter.workflow_id === undefined || event.workflow_id === filter.workflow_id)
      && (filter.server_id === undefined || event.server_id === filter.server_id)
  }

  findLastByCorrelation(correlationId: string, type: string): EdmoreEvent | undefined {
    return this.events.findLast(event => event.correlation_id === correlationId && event.type === type)
  }

  private validate(input: Pick<EdmoreEvent, 'type'> & Partial<EdmoreEvent>): void {
    const type = input.type
    if (!CORE_EVENTS.has(type) && !type.startsWith('user.') && !type.startsWith('edmore.custom.')) {
      throw new Error(`edmore event type is not allowed: ${type}`)
    }
    if (type.startsWith('user.') || type.startsWith('edmore.custom.')) {
      const payload = input.payload as { action?: unknown } | undefined
      if (typeof payload?.action === 'string' && FORBIDDEN_CUSTOM_ACTIONS.has(payload.action)) {
        throw new Error(`custom event cannot directly request hardware action: ${payload.action}`)
      }
    }
  }

  private async load(): Promise<void> {
    let body = ''
    try {
      body = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const loaded: EdmoreEvent[] = []
    for (const [index, line] of body.split('\n').entries()) {
      const text = line.trim()
      if (text.length === 0) continue
      try {
        loaded.push(JSON.parse(text) as EdmoreEvent)
      } catch (error) {
        console.warn(`Skipping malformed EDMore event log line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.events = loaded
    this.nextCursor = Math.max(0, ...loaded.map(event => event.cursor)) + 1
  }
}

class EdmoreActionRegistry {
  private running = new Map<string, Promise<unknown>>()

  constructor(private hub: EdmoreEventHub) {}

  async run<T>(actionId: string, action: string, sessionId: string | undefined, execute: () => Promise<T>): Promise<{ action_id: string; replayed: boolean; result: T }> {
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(actionId)) throw new Error('action_id must be 8-160 characters using letters, numbers, dot, underscore, colon, or dash')
    const completed = this.hub.findLastByCorrelation(actionId, 'edmore.custom.action.completed')
    if (completed !== undefined) {
      const payload = asRecord(completed.payload)
      if (payload.action !== action) throw new Error(`action_id '${actionId}' was already used for '${String(payload.action)}'`)
      return { action_id: actionId, replayed: true, result: payload.result as T }
    }
    const failed = this.hub.findLastByCorrelation(actionId, 'edmore.custom.action.failed')
    if (failed !== undefined) {
      const payload = asRecord(failed.payload)
      if (payload.action !== action) throw new Error(`action_id '${actionId}' was already used for '${String(payload.action)}'`)
      throw new Error(typeof payload.error === 'string' ? payload.error : `Action '${action}' previously failed`)
    }
    const current = this.running.get(actionId)
    if (current !== undefined) {
      return { action_id: actionId, replayed: true, result: await current as T }
    }
    const accepted = this.hub.findLastByCorrelation(actionId, 'edmore.custom.action.accepted')
    if (accepted !== undefined) {
      throw new Error(`Action '${actionId}' was accepted before the backend restarted, but its outcome is unknown. Inspect workflow state before retrying with a new action_id.`)
    }
    const promise = (async () => {
      await this.hub.append({
        type: 'edmore.custom.action.accepted',
        source: 'edmore-client-api',
        scope: 'workflow',
        ...sessionId === undefined ? {} : { session_id: sessionId },
        correlation_id: actionId,
        payload: { action },
      })
      try {
        const result = await execute()
        await this.hub.append({
          type: 'edmore.custom.action.completed',
          source: 'edmore-client-api',
          scope: 'workflow',
          ...sessionId === undefined ? {} : { session_id: sessionId },
          correlation_id: actionId,
          payload: { action, result },
        })
        return result
      } catch (error) {
        await this.hub.append({
          type: 'edmore.custom.action.failed',
          source: 'edmore-client-api',
          scope: 'workflow',
          ...sessionId === undefined ? {} : { session_id: sessionId },
          correlation_id: actionId,
          payload: { action, error: error instanceof Error ? error.message : String(error) },
        })
        throw error
      }
    })()
    this.running.set(actionId, promise)
    try {
      return { action_id: actionId, replayed: false, result: await promise }
    } finally {
      this.running.delete(actionId)
    }
  }
}

class NionSwiftBridge {
  constructor(private hub: EdmoreEventHub, private baseUrl: string) {}

  async status(): Promise<{ ok: boolean; agents: string[]; agentInfo: Record<string, NionSwiftAgentInfo>; message: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/agents`)
      if (!response.ok) return { ok: false, agents: [], agentInfo: {}, message: `HTTP ${response.status}` }
      const data = await response.json()
      if (!Array.isArray(data)) return { ok: false, agents: [], agentInfo: {}, message: 'agents response is not a JSON list' }
      const infos = data.map(normalizeNionSwiftAgentInfo).filter((item): item is NionSwiftAgentInfo => item !== undefined)
      const agentInfo = Object.fromEntries(infos.map(info => [info.name, info]))
      return { ok: true, agents: infos.map(info => info.name), agentInfo, message: 'ok' }
    } catch (error) {
      return { ok: false, agents: [], agentInfo: {}, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async listTools(agent: string): Promise<unknown> {
    const client = await this.connectAgent(agent)
    try {
      return await client.request({ method: 'tools/list' }, ListToolsResultSchema)
    } finally {
      await client.close()
    }
  }

  async listResources(agent: string): Promise<unknown> {
    const client = await this.connectAgent(agent)
    try {
      return await client.request({ method: 'resources/list' }, ListResourcesResultSchema)
    } finally {
      await client.close()
    }
  }

  async readResource(agent: string, uri: string): Promise<unknown> {
    const client = await this.connectAgent(agent)
    try {
      return await client.request({ method: 'resources/read', params: { uri } }, ReadResourceResultSchema)
    } finally {
      await client.close()
    }
  }

  async callTool(agent: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const client = await this.connectAgent(agent)
    try {
      return await client.request(
        { method: 'tools/call', params: { name, arguments: args } },
        RawCallToolResultSchema,
        { signal, timeout: 60_000 },
      ) as Record<string, unknown>
    } finally {
      await client.close()
    }
  }

  async observe(): Promise<void> {
    const status = await this.status()
    await this.hub.append({
      type: status.ok ? 'edmore.server.heartbeat' : 'edmore.instrument.status_changed',
      source: 'nionswift-mcp',
      scope: 'nionswift',
      server_id: 'nionswift',
      payload: status,
    })
  }

  async connectAgent(agent: string): Promise<Client> {
    const client = new Client({ name: 'edmore-harness-nionswift-bridge', version: '0.1.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp/${encodeURIComponent(agent)}/`))
    await client.connect(transport as Transport)
    return client
  }
}

class EdmoreHarnessMcpToolBridge {
  private disposers = new Map<string, Map<string, () => void>>()
  private signatures = new Map<string, string>()
  private syncRunning = false

  constructor(
    private ctx: Context,
    private hub: EdmoreEventHub,
    private nionSwift: NionSwiftBridge,
    private workflow: EdmoreWorkflow,
  ) {}

  async sync(): Promise<void> {
    if (this.syncRunning) return
    this.syncRunning = true
    try {
      const status = await this.nionSwift.status()
      if (!status.ok) return
      const agents = new Set(status.agents)
      for (const agent of [...this.disposers.keys()]) {
        if (agents.has(agent)) continue
        this.removeAgent(agent)
      }
      for (const agent of status.agents) {
        await this.syncAgent(agent)
      }
    } finally {
      this.syncRunning = false
    }
  }

  schemas(): unknown[] {
    return this.ctx.tools.schemas()
      .filter(schema => schema.name.startsWith('mcp__nionswift_'))
      .map(schema => ({
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
      }))
  }

  async dispose(): Promise<void> {
    for (const agent of [...this.disposers.keys()]) this.removeAgent(agent)
  }

  private async syncAgent(agent: string): Promise<void> {
    const serverName = this.serverName(agent)
    const listing = await this.nionSwift.listTools(agent) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }
    const definitions = new Map<string, ToolDefinition>()
    for (const tool of listing.tools ?? []) {
      const rawName = tool.name
      const publicName = publicToolName(serverName, rawName)
      definitions.set(publicName, {
        name: publicName,
        description: tool.description ?? '',
        parameters: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: {
              content: { type: 'array', items: {} },
              structuredContent: {},
            },
            required: ['content'],
            additionalProperties: false,
          },
          render(_args, value) {
            const result = asRecord(value)
            const content = Array.isArray(result.content) ? result.content : []
            return projectMcpContent(content, rawName)
          },
        },
        execute: async (args, exec) => {
          const callId = String(exec.callId)
          await this.workflow.beforeLoopToolCall(exec.agent?.id, agent, rawName, asRecord(args), callId)
          try {
            const result = await this.nionSwift.callTool(
              agent,
              rawName,
              asRecord(args),
              exec.signal,
            )
            await this.workflow.afterLoopToolResult(exec.agent?.id, agent, rawName, callId, result)
            const content = Array.isArray(result.content) ? result.content : []
            if (result.isError === true) throw new Error(contentText(projectMcpContent(content, rawName)))
            return {
              content,
              ...result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent },
            }
          } catch (error) {
            await this.workflow.handleLoopToolError(exec.agent?.id, agent, rawName, callId, error)
            throw error
          }
        },
      })
    }
    const previous = this.disposers.get(agent) ?? new Map()
    for (const dispose of previous.values()) dispose()
    const next = new Map<string, () => void>()
    for (const [publicName, definition] of definitions) {
      next.set(publicName, this.ctx.tools.register(definition))
    }
    this.disposers.set(agent, next)
    const signature = JSON.stringify([...next.keys()])
    if (this.signatures.get(agent) !== signature) {
      this.signatures.set(agent, signature)
      await this.hub.append({
        type: 'edmore.custom.harness_tools_synced',
        source: 'edmore-mcp-bridge',
        scope: 'workflow',
        server_id: 'nionswift',
        payload: {
          agent,
          serverName,
          tool_count: next.size,
          tools: [...next.keys()],
        },
      })
    }
  }

  private removeAgent(agent: string): void {
    for (const dispose of this.disposers.get(agent)?.values() ?? []) dispose()
    this.disposers.delete(agent)
    this.signatures.delete(agent)
  }

  private serverName(agent: string): string {
    return `nionswift_${agent}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  }
}

class EdmoreSkillContext {
  constructor(private ctx: Context, private cwd: string) {}

  async catalog(): Promise<{ complete: boolean; skills: Array<SkillSummary & { metadata?: Readonly<Record<string, unknown>> }> }> {
    const snapshot = await this.ctx.skills.snapshot({ cwd: this.cwd })
    return {
      complete: snapshot.complete,
      skills: snapshot.skills
        .filter(isModelInvocable)
        .map(skill => skill as SkillSummary & { metadata?: Readonly<Record<string, unknown>> }),
    }
  }

  async loadRelevant(prompt: string, limit = 3): Promise<SkillDefinition[]> {
    const { skills } = await this.catalog()
    const ranked = skills
      .map(skill => ({ skill, score: scoreSkill(prompt, skill) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, limit)
    const loaded: SkillDefinition[] = []
    for (const { skill } of ranked) {
      const definition = await this.ctx.skills.get(skill.name, { cwd: this.cwd })
      if (definition !== undefined && isModelInvocable(definition)) loaded.push(definition)
    }
    return loaded
  }

  async promptContext(prompt: string): Promise<string> {
    const { complete, skills } = await this.catalog()
    const lines = [
      'EDMORE Harness skills are available through the native Harness skill registry.',
      `Skill catalog status: ${complete ? 'complete' : 'incomplete'}.`,
      '',
      '<available_edmore_skills>',
      ...skills.map(skill => `- ${skill.name}: ${skill.description}`),
      '</available_edmore_skills>',
    ]
    const loaded = await this.loadRelevant(prompt)
    if (loaded.length > 0) {
      lines.push('', '<loaded_relevant_edmore_skills>')
      for (const skill of loaded) lines.push(renderSkillContent(skill))
      lines.push('</loaded_relevant_edmore_skills>')
    }
    return lines.join('\n')
  }
}

class EdmoreLlmProviderManager {
  private store: LlmProviderStore = {}
  private readyPromise: Promise<void>

  constructor(
    private ctx: Context,
    private hub: EdmoreEventHub,
    private path: string,
    private fallback: AssistantConfig,
  ) {
    this.readyPromise = this.load()
  }

  async ready(): Promise<void> {
    await this.readyPromise
  }

  async activeAssistantConfig(): Promise<AssistantConfig> {
    await this.ready()
    const active = this.profiles().find(profile => profile.id === this.activeProviderId())
    if (active === undefined) return this.fallback
    return {
      provider: active.id,
      model: active.model,
      ...active.reasoningEffort === undefined ? {} : { reasoningEffort: active.reasoningEffort },
      maxTokens: this.fallback.maxTokens,
      timeoutMs: this.fallback.timeoutMs,
    }
  }

  async list(): Promise<{ activeProvider: string; profiles: unknown[] }> {
    await this.ready()
    const profiles = await Promise.all(this.profiles().map(async (profile) => ({
      id: profile.id,
      displayName: profile.displayName,
      baseURL: profile.baseURL ?? '',
      model: profile.model,
      embeddingBaseURL: profile.embeddingBaseURL ?? '',
      embeddingModel: profile.embeddingModel ?? '',
      apiKeyEnv: profile.apiKeyEnv,
      api: profile.api ?? 'openai-completions',
      reasoningEffort: profile.reasoningEffort,
      active: profile.id === this.activeProviderId(),
      credential: profile.apiKeyEnv === undefined
        ? { configured: false, writable: true }
        : await credentialsService(this.ctx)?.describe(credentialRefName(profile.apiKeyEnv)) ?? { configured: false, writable: false },
    })))
    return { activeProvider: this.activeProviderId(), profiles }
  }

  async upsert(input: LlmProviderInput): Promise<LlmProviderProfile> {
    await this.ready()
    const id = this.normalizeProviderId(stringField(input.id, 'id'))
    const displayName = optionalString(input.displayName) || id
    const model = stringField(input.model, 'model')
    const baseURL = optionalString(input.baseURL) || optionalString(input.base_url)
    const embeddingBaseURL = optionalString(input.embeddingBaseURL) || optionalString(input.embedding_base_url)
    const embeddingModel = optionalString(input.embeddingModel) || optionalString(input.embedding_model)
    const api = optionalString(input.api) || (id === 'openai' ? undefined : 'openai-completions')
    const explicitApiKeyEnv = optionalString(input.apiKeyEnv) || optionalString(input.api_key_env)
    const apiKey = optionalString(input.apiKey) || optionalString(input.api_key)
    const reasoningEffort = optionalString(input.reasoningEffort) || optionalString(input.reasoning_effort)
    const previous = this.profiles().find(profile => profile.id === id)
    const apiKeyEnv = explicitApiKeyEnv || previous?.apiKeyEnv || defaultCredentialRefForProvider(id)
    if (apiKey) await this.setCredential(apiKeyEnv, apiKey)
    const profile = compactProfile({
      id,
      displayName,
      ...baseURL === undefined ? {} : { baseURL },
      model,
      ...embeddingBaseURL === undefined ? {} : { embeddingBaseURL },
      ...embeddingModel === undefined ? {} : { embeddingModel },
      ...apiKeyEnv === undefined ? {} : { apiKeyEnv },
      ...api === undefined ? {} : { api },
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
    this.store.profiles = [
      ...this.profiles().filter(item => item.id !== id),
      profile,
    ]
    if (this.store.activeProvider === undefined) this.store.activeProvider = id
    await this.persist()
    if (!await this.syncHarnessSettings()) throw new Error('Harness LLM settings are not ready yet')
    await this.hub.append({
      type: 'edmore.llm.provider.updated',
      source: 'edmore-client-api',
      scope: 'global',
      payload: {
        id: profile.id,
        displayName: profile.displayName,
        model: profile.model,
        baseURL: profile.baseURL ?? '',
        apiKeyEnv: profile.apiKeyEnv,
        apiKeyConfigured: profile.apiKeyEnv === undefined ? false : ((await credentialsService(this.ctx)?.describe(credentialRefName(profile.apiKeyEnv))) as { configured?: boolean } | undefined)?.configured ?? false,
      },
    })
    return profile
  }

  async select(id: string): Promise<void> {
    await this.ready()
    const normalized = this.normalizeProviderId(id)
    if (!this.profiles().some(profile => profile.id === normalized)) {
      throw new Error(`LLM provider not found: ${normalized}`)
    }
    this.store.activeProvider = normalized
    await this.persist()
    await this.hub.append({
      type: 'edmore.llm.provider.selected',
      source: 'edmore-client-api',
      scope: 'global',
      payload: { id: normalized },
    })
  }

  async delete(id: string): Promise<void> {
    await this.ready()
    const normalized = this.normalizeProviderId(id)
    if (normalized === 'llm3-hu' || normalized === 'openai') {
      throw new Error(`built-in provider cannot be deleted: ${normalized}`)
    }
    this.store.profiles = (this.store.profiles ?? []).filter(profile => profile.id !== normalized)
    if (this.store.activeProvider === normalized) this.store.activeProvider = 'openai'
    await this.persist()
    if (!await this.syncHarnessSettings()) throw new Error('Harness LLM settings are not ready yet')
    await this.hub.append({
      type: 'edmore.llm.provider.updated',
      source: 'edmore-client-api',
      scope: 'global',
      payload: { id: normalized, deleted: true },
    })
  }

  private async load(): Promise<void> {
    try {
      this.store = JSON.parse(await readFile(this.path, 'utf8')) as LlmProviderStore
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.store = {}
    }
    if (!Array.isArray(this.store.profiles)) this.store.profiles = []
    if (this.store.activeProvider === undefined) this.store.activeProvider = 'openai'
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, `${JSON.stringify(this.store, null, 2)}\n`, 'utf8')
  }

  startSyncLoop(): () => void {
    let stopped = false
    const sync = async (): Promise<void> => {
      if (stopped) return
      if (await this.syncHarnessSettings()) return
      setTimeout(() => { void sync() }, 500)
    }
    void sync()
    return () => { stopped = true }
  }

  private profiles(): LlmProviderProfile[] {
    const merged = new Map(DEFAULT_LLM_PROVIDER_PROFILES.map(profile => [profile.id, profile]))
    for (const profile of this.store.profiles ?? []) merged.set(profile.id, profile)
    return [...merged.values()]
  }

  private activeProviderId(): string {
    const id = this.store.activeProvider ?? 'openai'
    return this.profiles().some(profile => profile.id === id) ? id : 'openai'
  }

  private async syncHarnessSettings(): Promise<boolean> {
    const settings = settingsService(this.ctx)
    if (settings === undefined) return false
    await this.ensureDefaultCredentials()
    const providers: Record<string, unknown> = {}
    for (const profile of this.profiles()) {
      providers[profile.id] = {
        displayName: profile.displayName,
        ...profile.apiKeyEnv === undefined ? {} : { apiKeyEnv: profile.apiKeyEnv },
        ...profile.api === undefined ? {} : { api: profile.api },
        ...profile.baseURL === undefined || profile.baseURL === '' ? {} : { baseURL: profile.baseURL },
        models: [{
          id: profile.model,
          name: profile.model,
        }],
      }
    }
    try {
      await settings.replace('llm-pi-ai', { providers })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('settings namespace "llm-pi-ai" is not registered')) return false
      throw error
    }
  }

  private async setCredential(apiKeyEnv: string, value: string): Promise<void> {
    const credentials = credentialsService(this.ctx)
    if (credentials === undefined) throw new Error('EDMORE LLM provider configuration requires Harness credentials service')
    await credentials.set(credentialRefName(apiKeyEnv), value)
  }

  private async ensureDefaultCredentials(): Promise<void> {
    const credentials = credentialsService(this.ctx)
    if (credentials === undefined) return
    const hu = await credentials.describe('EDMORE_HU_LLM_API_KEY')
    if (!((hu as { configured?: boolean } | undefined)?.configured)) {
      await credentials.set('EDMORE_HU_LLM_API_KEY', 'required-but-not-used')
    }
  }

  private normalizeProviderId(id: string): string {
    const normalized = id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!normalized) throw new Error('provider id is required')
    return normalized
  }
}

class EdmoreAgentRoleManager {
  private store: AgentRoleStore = {}
  private readyPromise: Promise<void>

  constructor(
    private hub: EdmoreEventHub,
    private path: string,
    private providers: EdmoreLlmProviderManager,
    private nionSwift: NionSwiftBridge,
  ) {
    this.readyPromise = this.load()
  }

  async ready(): Promise<void> {
    await this.readyPromise
  }

  async configFor(role: string): Promise<AssistantConfig> {
    return (await this.resolve(role)).config
  }

  async list(): Promise<{ priority: AgentConfigSource[]; roles: Record<string, AssistantConfig & { sources: Record<keyof AssistantConfig, AgentConfigSource> }> }> {
    await this.ready()
    const status = await this.nionSwift.status()
    const roles: Record<string, AssistantConfig & { sources: Record<keyof AssistantConfig, AgentConfigSource> }> = {}
    for (const role of ['orchestrator', 'planner', 'judge', 'title_generator']) {
      const resolved = await this.resolve(role)
      roles[role] = { ...resolved.config, sources: resolved.sources }
    }
    if (status.ok) {
      for (const agent of status.agents) {
        const role = executorRoleForMcpAgent(agent)
        const resolved = await this.resolve(role)
        roles[role] = { ...resolved.config, sources: resolved.sources }
      }
    }
    return { priority: ['user_role', 'mcp_agent', 'backend_default'], roles }
  }

  private async resolve(role: string): Promise<ResolvedAgentConfig> {
    await this.ready()
    const base = await this.providers.activeAssistantConfig()
    const baseRole = baseRoleFor(role)
    const backend = { ...base, ...(DEFAULT_AGENT_ROLE_CONFIGS[baseRole] ?? {}) }
    const agentInfo = role.startsWith('executor:') ? await this.requireOnlineExecutorAgent(role) : undefined
    const mcp = assistantConfigFromAgentInfo(agentInfo)
    const user = {
      ...(this.store.roles?.[baseRole] ?? {}),
      ...(this.store.roles?.[role] ?? {}),
    }
    const sourceFor = (key: keyof AssistantConfig): AgentConfigSource => user[key] !== undefined
      ? 'user_role'
      : mcp[key] !== undefined
        ? 'mcp_agent'
        : 'backend_default'
    const reasoningEffort = user.reasoningEffort ?? mcp.reasoningEffort ?? backend.reasoningEffort
    const config: AssistantConfig = {
      provider: user.provider ?? mcp.provider ?? backend.provider,
      model: user.model ?? mcp.model ?? backend.model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      maxTokens: user.maxTokens ?? mcp.maxTokens ?? backend.maxTokens,
      timeoutMs: user.timeoutMs ?? mcp.timeoutMs ?? backend.timeoutMs,
    }
    return {
      config,
      sources: {
        provider: sourceFor('provider'),
        model: sourceFor('model'),
        reasoningEffort: sourceFor('reasoningEffort'),
        maxTokens: sourceFor('maxTokens'),
        timeoutMs: sourceFor('timeoutMs'),
      },
    }
  }

  async upsert(input: AgentRoleConfigInput): Promise<{ role: string; config: Partial<AssistantConfig> }> {
    await this.ready()
    const role = normalizeRoleId(stringField(input.role, 'role'))
    const previous = this.store.roles?.[role] ?? DEFAULT_AGENT_ROLE_CONFIGS[role] ?? {}
    const provider = optionalString(input.provider) ?? previous.provider
    const model = optionalString(input.model) ?? previous.model
    const reasoningEffort = optionalString(input.reasoningEffort) ?? optionalString(input.reasoning_effort) ?? previous.reasoningEffort
    const maxTokensInput = input.maxTokens ?? input.max_tokens
    const maxTokens = typeof maxTokensInput === 'number' && Number.isFinite(maxTokensInput) && maxTokensInput > 0
      ? Math.floor(maxTokensInput)
      : previous.maxTokens
    const timeoutMsInput = input.timeoutMs ?? input.timeout_ms
    const timeoutMs = typeof timeoutMsInput === 'number' && Number.isFinite(timeoutMsInput) && timeoutMsInput >= 1000
      ? Math.floor(timeoutMsInput)
      : previous.timeoutMs
    const config = compactAssistantConfig({
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...timeoutMs === undefined ? {} : { timeoutMs },
    })
    this.store.roles = { ...(this.store.roles ?? {}), [role]: config }
    await this.persist()
    await this.hub.append({
      type: 'edmore.custom.agent_role.updated',
      source: 'edmore-client-api',
      scope: 'global',
      payload: { role, config },
    })
    return { role, config }
  }

  private async load(): Promise<void> {
    try {
      this.store = JSON.parse(await readFile(this.path, 'utf8')) as AgentRoleStore
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.store = {}
    }
    if (this.store.roles === undefined || typeof this.store.roles !== 'object') this.store.roles = {}
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, `${JSON.stringify(this.store, null, 2)}\n`, 'utf8')
  }

  private async requireOnlineExecutorAgent(role: string): Promise<NionSwiftAgentInfo> {
    const agent = role.slice('executor:'.length)
    if (!agent) throw new Error(`invalid executor role: ${role}`)
    const status = await this.nionSwift.status()
    if (!status.ok || !status.agents.includes(agent)) {
      throw new Error(`MCP agent '${agent}' is not online; executor role '${role}' is unavailable.`)
    }
    return status.agentInfo[agent] ?? { name: agent }
  }
}

class EdmoreAgentLoopBridge {
  private handledTriggers = new Set<string>()
  private agents = new Map<string, {
    handle: AgentHandle
    selection: ModelSelectionRef
    chain: Promise<void>
    configSignature: string
  }>()

  constructor(
    private ctx: Context,
    private hub: EdmoreEventHub,
    private roles: EdmoreAgentRoleManager,
    private workflow: EdmoreWorkflow,
  ) {}

  async handleTrigger(event: EdmoreEvent): Promise<void> {
    if (this.handledTriggers.has(event.event_id)) return
    this.handledTriggers.add(event.event_id)
    const payload = event.payload as { prompt?: unknown } | undefined
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
    if (!prompt) return
    const sessionId = event.session_id ?? 'default'
    const role = 'orchestrator'
    const entry = await this.ensureAgent(sessionId, role)
    const current = entry.chain
    const next = current
      .catch(() => undefined)
      .then(() => this.runPrompt(sessionId, role, prompt, event))
    this.agents.set(this.agentKey(sessionId, role), {
      ...entry,
      chain: next.then(() => undefined, () => undefined),
    })
    await next
  }

  async runWorkflow(sourceEvent: EdmoreEvent, prompt: string, workflowId?: string, role = 'orchestrator'): Promise<void> {
    const sessionId = sourceEvent.session_id ?? 'default'
    const event: EdmoreEvent = {
      ...sourceEvent,
      ...workflowId === undefined && sourceEvent.workflow_id === undefined ? {} : { workflow_id: workflowId ?? sourceEvent.workflow_id },
      payload: {
        prompt,
        origin: 'approved-workflow',
        role,
        source_event_id: sourceEvent.event_id,
        ...workflowId === undefined && sourceEvent.workflow_id === undefined ? {} : { workflow_id: workflowId ?? sourceEvent.workflow_id },
      },
    }
    const entry = await this.ensureAgent(sessionId, role)
    const current = entry.chain
    const next = current
      .catch(() => undefined)
      .then(() => this.runPrompt(sessionId, role, prompt, event, workflowId, 0))
    this.agents.set(this.agentKey(sessionId, role), {
      ...entry,
      chain: next.then(() => undefined, () => undefined),
    })
    await next
  }

  async runRoleOnce(sessionId: string, role: string, prompt: string, event: EdmoreEvent, options: RoleRunOptions = {}): Promise<string> {
    const entry = await this.ensureAgent(sessionId, role)
    const current = entry.chain
    const next = current
      .catch(() => undefined)
      .then(() => this.runPrompt(sessionId, role, prompt, event, undefined, 0, options))
    this.agents.set(this.agentKey(sessionId, role), {
      ...entry,
      chain: next.then(() => undefined, () => undefined),
    })
    return await next
  }

  async dispose(): Promise<void> {
    const entries = [...this.agents.values()]
    this.agents.clear()
    await Promise.all(entries.map(entry => entry.handle.dispose()))
  }

  private async runPrompt(
    sessionId: string,
    role: string,
    prompt: string,
    event: EdmoreEvent,
    workflowId?: string,
    depth = 0,
    options: RoleRunOptions = {},
  ): Promise<string> {
    const entry = await this.ensureAgent(sessionId, role)
    const config = await this.roles.configFor(role)
    entry.selection.current = {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) },
    }
    const responseId = randomUUID()
    const firstSeq = entry.handle.agent.session.seq
    const transcript = new Map<string, string>()
    let finalText = ''
    let modelError: string | undefined
    const disposeStream = this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent !== entry.handle.agent) return
      void this.projectAssistantFrame(frame, event, responseId, config, transcript, role, options)
        .catch(error => this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
    })
    const disposeSession = this.ctx.on('session/event', (session, sessionEvent) => {
      if (session !== entry.handle.agent.session) return
      void this.projectSessionEvent(sessionEvent, event, responseId)
        .catch(error => this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
    })
    try {
      entry.handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        entry.handle.agent.cancel({ kind: 'hook', reason: `EDMORE ${role} timed out after ${config.timeoutMs} ms` })
      }, config.timeoutMs)
      try {
        await entry.handle.agent.whenIdle()
      } finally {
        clearTimeout(timeout)
      }
      if (timedOut) throw new Error(`EDMORE ${role} timed out after ${config.timeoutMs} ms`)
      const outcome = summarizeAssistantOutput(entry.handle.agent.session, firstSeq)
      finalText = outcome.text.trim()
      modelError = outcome.error
      await this.hub.append(withOptionalSession({
        type: outcome.error === undefined ? 'edmore.assistant.completed' : 'edmore.assistant.failed',
        source: options.source ?? 'edmore-agent-loop',
        scope: 'workflow',
        correlation_id: event.event_id,
        payload: {
          response_id: responseId,
          session_id: entry.handle.agent.id,
          role,
          provider: config.provider,
          model: config.model,
          text: finalText,
          usage: outcome.usage,
          ...options.hidden === true ? { hidden: true } : {},
          ...outcome.error === undefined ? {} : { error: outcome.error },
        },
      }, event.session_id))
    } catch (error) {
      await this.hub.append(withOptionalSession({
        type: 'edmore.assistant.failed',
        source: options.source ?? 'edmore-agent-loop',
        scope: 'workflow',
        correlation_id: event.event_id,
        payload: {
          response_id: responseId,
          session_id: entry.handle.agent.id,
          role,
          ...options.hidden === true ? { hidden: true } : {},
          error: error instanceof Error ? error.message : String(error),
        },
      }, event.session_id))
      throw error
    } finally {
      const flushReport: Record<string, unknown> = {}
      try {
        flushReport.sessionFlushParticipated = await this.ctx.sessions.flush(entry.handle.agent.session)
      } catch (error) {
        flushReport.sessionFlushError = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
      try {
        const persistence = this.ctx.get('sessionPersistence')
        flushReport.persistenceServiceAvailable = persistence !== undefined
        if (persistence !== undefined) await persistence.flush()
      } catch (error) {
        flushReport.persistenceFlushError = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
      if (Object.keys(flushReport).length > 0) {
        await this.hub.append(withOptionalSession({
          type: 'edmore.custom.session_persistence.flush',
          source: 'edmore-agent-loop',
          scope: 'workflow',
          correlation_id: event.event_id,
          payload: {
            session_id: entry.handle.agent.id,
            role,
            ...flushReport,
            ...options.hidden === true ? { hidden: true } : {},
          },
        }, event.session_id)).catch(error => this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
      }
      disposeSession()
      disposeStream()
    }
    if (modelError !== undefined) throw new Error(modelError)
    const dispatch = workflowId === undefined || depth >= 50
      ? undefined
      : this.workflow.nextLoopDispatch(sessionId, workflowId) ?? this.workflow.nextLoopDispatch(sessionId)
    if (dispatch !== undefined) {
      await this.hub.append(withOptionalSession({
        type: 'edmore.custom.workflow_handoff',
        source: 'edmore-agent-loop',
        scope: 'workflow',
        workflow_id: dispatch.workflowId,
        correlation_id: event.event_id,
        payload: {
          from_role: role,
          to_role: dispatch.role,
          step_id: dispatch.step.step_id,
          agent: dispatch.step.agent,
          tool_name: dispatch.step.tool_name,
        },
      }, event.session_id))
      await this.runPrompt(sessionId, dispatch.role, dispatch.prompt, event, dispatch.workflowId, depth + 1)
    }
    return finalText
  }

  private async ensureAgent(sessionId: string, role: string): Promise<{
    handle: AgentHandle
    selection: ModelSelectionRef
    chain: Promise<void>
    configSignature: string
  }> {
    const key = this.agentKey(sessionId, role)
    const config = await this.roles.configFor(role)
    const existing = this.agents.get(key)
    const configSignature = JSON.stringify(config)
    if (existing !== undefined && existing.configSignature === configSignature) return existing
    if (existing !== undefined) {
      await existing.chain.catch(() => undefined)
      await this.ctx.sessions.flush(existing.handle.agent.session).catch(() => false)
      await existing.handle.dispose()
      this.agents.delete(key)
    }
    const selection: ModelSelectionRef = {
      current: {
        provider: config.provider,
        model: config.model,
        ...config.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) },
      },
      assembled: undefined,
    }
    const harnessSessionId = SessionId(`edmore-${normalizeSessionId(sessionId)}-${normalizeSessionId(role)}`)
    const agentOptions = {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) },
      maxTokens: config.maxTokens,
    }
    const setup = (agentCtx: Context) => {
        installModelSelection(agentCtx, selection)
        const allow = allowedToolNamesForRole(role, this.ctx.tools.schemas().map(schema => schema.name))
        if (allow !== undefined) agentCtx.tools.restrict({ allow })
        agentCtx.on('tools/pre-execute', async (exec, next) => {
          const mcp = /^mcp__nionswift_([^_]+(?:_[^_]+)*)__/.exec(exec.name)
          const agent = mcp?.[1]
          if (agent !== undefined && !roleAllowsMcpAgent(role, agent)) {
            return { kind: 'deny', reason: `EDMORE role ${role} cannot call ${exec.name}.` }
          }
          return await next()
        })
        agentCtx.systemPrompt.section({
          name: 'edmore:persona',
          order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 20,
          text: this.systemPromptForRole(role),
        })
    }
    const persistence = this.ctx.get('sessionPersistence')
    let handle: AgentHandle
    if (persistence !== undefined && await persistence.stat(harnessSessionId) !== undefined) {
      try {
        handle = await this.ctx.agents.resume({
          resumeSessionId: harnessSessionId,
          agentOptions,
          setup,
        })
      } catch (error) {
        if (!(error instanceof SessionPersistenceNotFoundError)) throw error
        handle = await this.ctx.agents.create({
          sessionId: harnessSessionId,
          meta: { cwd: process.cwd() },
          agentOptions,
          setup,
        })
      }
    } else {
      handle = await this.ctx.agents.create({
        sessionId: harnessSessionId,
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
    }
    const entry = { handle, selection, chain: Promise.resolve(), configSignature }
    this.agents.set(key, entry)
    this.workflow.bindHarnessSession(String(handle.agent.id), sessionId)
    await this.hub.append({
      type: 'edmore.custom.agent_loop_session.created',
      source: 'edmore-agent-loop',
      scope: 'workflow',
      session_id: sessionId,
      payload: {
        harness_session_id: handle.agent.id,
        role,
        provider: config.provider,
        model: config.model,
      }
    })
    return entry
  }

  private agentKey(sessionId: string, role: string): string {
    return `${sessionId}:${role}`
  }

  private systemPromptForRole(role: string): string {
    if (role.startsWith('executor:')) {
      const agent = role.slice('executor:'.length)
      return [
        `You are the EDMORE executor for NionSwift MCP namespace ${agent}.`,
        'Execute only the approved current step given by the EDMORE workflow plugin.',
        'Call exactly the requested Harness MCP tool when it is available, then stop and report the concrete result.',
        'Do not plan, replan, skip steps, call tools from other MCP namespaces, or continue to a later step by yourself.',
        'If a required input or user confirmation is missing, stop and say what is required.',
      ].join('\n')
    }
    if (role === 'planner') {
      return [
        'You are the EDMORE planner. Convert user goals into grounded PlanReview objects using visible skills, MCP schemas, and current state.',
        'Do not execute hardware tools. Produce plans only.',
      ].join('\n')
    }
  if (role === 'judge') {
      return [
        'You are the EDMORE semantic judge. Review plans for missing steps, unsafe assumptions, wrong MCP agent ownership, and missing user gates.',
        'Do not execute hardware tools. Deterministic policy gates are authoritative.',
    ].join('\n')
  }
    if (role === 'title_generator') {
      return [
        'You generate concise conversation titles for EDMORE microscope workflows.',
        'Return only the title text, no quotes, no markdown, no explanation.',
        'Use 3 to 8 words. Prefer concrete microscopy terms from the user request.',
      ].join('\n')
    }
    return [
      'You are the EDMORE orchestrator for NionSwift microscope and ptychography workflows.',
      'Use available Harness MCP tools when the user asks about current NionSwift agents, tool inventory, parameters, resources, or when a workflow action requires live MCP state.',
      'Use Harness skills for workflow order, required inputs, user confirmation gates, and safety policy. If a task clearly matches an EDMORE skill, load that skill before acting.',
      'Do not claim that hardware has been changed unless an approved MCP tool result proves it.',
      'For destructive, acquisition, server submission, or hardware-changing actions, explain the needed plan and approval instead of directly executing unsafe changes.',
    ].join('\n')
  }

  private async projectAssistantFrame(
    frame: AssistantStreamFrame,
    event: EdmoreEvent,
    responseId: string,
    config: AssistantConfig,
    transcript: Map<string, string>,
    role: string,
    options: RoleRunOptions,
  ): Promise<void> {
    if (frame.type === 'start') {
      await this.hub.append(withOptionalSession({
        type: 'edmore.assistant.started',
        source: options.source ?? 'edmore-agent-loop',
        scope: 'workflow',
        correlation_id: event.event_id,
        payload: {
          response_id: responseId,
          attempt_id: frame.attemptId,
          role,
          provider: config.provider,
          model: config.model,
          turn: frame.turn,
          step: frame.step,
          ...options.hidden === true ? { hidden: true } : {},
        },
      }, event.session_id))
      return
    }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta') {
      const previous = transcript.get(String(frame.attemptId)) ?? ''
      transcript.set(String(frame.attemptId), previous + chunk.text)
      await this.hub.append(withOptionalSession({
        type: 'edmore.assistant.delta',
        source: options.source ?? 'edmore-agent-loop',
        scope: 'workflow',
        correlation_id: event.event_id,
        payload: {
          response_id: responseId,
          attempt_id: frame.attemptId,
          text: chunk.text,
          role,
          ...options.hidden === true ? { hidden: true } : {},
        },
      }, event.session_id))
    }
  }

  private async projectSessionEvent(sessionEvent: SessionEvent, event: EdmoreEvent, responseId: string): Promise<void> {
    if (sessionEvent.type === 'tool/call') {
      await this.hub.append(withOptionalSession({
        type: 'edmore.custom.harness_tool_call',
        source: 'edmore-agent-loop',
        scope: 'workflow',
        correlation_id: event.event_id,
        payload: {
          response_id: responseId,
          seq: sessionEvent.seq,
          turn: sessionEvent.data.turn,
          step: sessionEvent.data.step,
          call_id: sessionEvent.data.callId,
          name: sessionEvent.data.name,
          arguments: parseToolArguments(sessionEvent.data.arguments),
        },
      }, event.session_id))
      return
    }
    if (sessionEvent.type === 'tool/result') {
      const block = sessionEvent.data.message.content[0]
      await this.hub.append(withOptionalSession({
        type: 'edmore.custom.harness_tool_result',
        source: 'edmore-agent-loop',
        scope: 'workflow',
        correlation_id: event.event_id,
        payload: {
          response_id: responseId,
          seq: sessionEvent.seq,
          turn: sessionEvent.data.turn,
          step: sessionEvent.data.step,
          call_id: sessionEvent.data.message.source.callId,
          is_error: block?.type === 'tool-result' ? block.isError : false,
          content: block?.type === 'tool-result' ? block.content : [],
          text: block?.type === 'tool-result' ? contentText(block.content) : '',
        },
      }, event.session_id))
    }
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { raw }
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim().replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized || 'default'
}

function summarizeAssistantOutput(session: Session, firstSeq: number): { text: string; usage?: unknown; error?: string } {
  let text = ''
  let usage: unknown
  let error: string | undefined
  for (const event of session.snapshotEvents()) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined.trim()) text = joined
      if (event.data.usage !== undefined) usage = event.data.usage
    } else if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      error = `${event.data.reason.error.code}: ${event.data.reason.error.message}`
    }
  }
  return {
    text,
    ...usage === undefined ? {} : { usage },
    ...error === undefined ? {} : { error },
  }
}

function scoreSkill(prompt: string, skill: SkillSummary): number {
  const haystack = `${skill.name} ${skill.description} ${skill.whenToUse ?? ''}`.toLowerCase()
  const normalizedPrompt = prompt.toLowerCase().replace(/_/g, '-')
  let score = 0
  for (const token of skill.name.split('-')) {
    if (token.length >= 3 && normalizedPrompt.includes(token)) score += 3
  }
  for (const token of normalizedPrompt.split(/[^a-z0-9]+/).filter(token => token.length >= 3)) {
    if (haystack.includes(token)) score += 1
  }
  if (normalizedPrompt.includes(skill.name)) score += 20
  const legacyName = skill.name.replace(/-/g, '_')
  if (prompt.toLowerCase().includes(legacyName)) score += 20
  return score
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

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
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

function confirmationContextFromLegacyNionSwiftTrigger(event: EdmoreEvent): Record<string, unknown> {
  const fields = legacyNionSwiftFields(event)
  const payload = asRecord(event.payload)
  return {
    agent: fields.agent,
    tool_name: fields.toolName,
    trigger: fields.trigger,
    status: fields.status,
    tool_output: fields.toolOutput,
    ui_action_context: payload.ui_action_context ?? null,
  }
}

function displayTextFromLegacyNionSwiftTrigger(event: EdmoreEvent, asConfirmation: boolean): string {
  const fields = legacyNionSwiftFields(event)
  const toolName = fields.toolName ?? ''
  const trigger = fields.trigger ?? ''
  const toolOutput = fields.toolOutput ?? ''
  if (asConfirmation) {
    if (/roi/i.test(toolName) || /roi/i.test(trigger) || /roi/i.test(toolOutput)) {
      return 'Confirmed ROI selection in NionSwift.'
    }
    if (toolName) return `Confirmed ${toolName} in NionSwift.`
    return 'Confirmed the paused workflow step in NionSwift.'
  }
  const label = toolName || trigger || 'workflow event'
  return `NionSwift requested follow-up: ${label}`
}

function promptFromLegacyNionSwiftTrigger(event: EdmoreEvent, asConfirmation = false): string {
  if (asConfirmation) return 'confirm'
  const fields = legacyNionSwiftFields(event)

  const lines = [
    'NionSwift GUI/tool event requested an EDMORE assistant follow-up.',
    fields.agent ? `Agent: ${fields.agent}` : '',
    fields.toolName ? `Tool/action: ${fields.toolName}` : '',
    fields.trigger ? `Trigger: ${fields.trigger}` : '',
    fields.status ? `Status: ${fields.status}` : '',
    fields.requiredInputs ? `Required inputs: ${fields.requiredInputs}` : '',
    fields.error ? `Error: ${fields.error}` : '',
    fields.toolOutput ? `Tool output:\n${fields.toolOutput}` : '',
    fields.uiActionContext ? `UI action context:\n${fields.uiActionContext}` : '',
  ].filter(line => line.length > 0)

  return lines.join('\n\n')
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text) as Record<string, unknown>
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function sendError(res: ServerResponse, error: unknown): void {
  sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://x').searchParams
}

function eventQuery(req: IncomingMessage): EventFilter {
  const query = queryOf(req)
  const filter: EventFilter = {}
  if (query.has('after')) filter.after = Number(query.get('after'))
  if (query.has('scope')) filter.scope = query.get('scope') ?? ''
  if (query.has('session_id')) filter.session_id = query.get('session_id') ?? ''
  if (query.has('workflow_id')) filter.workflow_id = query.get('workflow_id') ?? ''
  if (query.has('server_id')) filter.server_id = query.get('server_id') ?? ''
  if (query.has('limit')) filter.limit = Number(query.get('limit'))
  return filter
}

function planApprovalUiSummary(plan: Record<string, unknown>): string {
  const judge = asRecord(plan.judge_report)
  const issues = Array.isArray(judge.issues) ? judge.issues.length : 0
  const steps = Array.isArray(plan.steps) ? plan.steps.length : 0
  return [
    textOf(plan.user_summary) || textOf(plan.summary) || 'I prepared a plan.',
    '',
    `Plan judge: ${textOf(judge.status) || 'pass'}${issues ? ` with ${issues} note${issues === 1 ? '' : 's'}` : ''}.`,
    `${steps} step${steps === 1 ? '' : 's'} are waiting for your approval.`,
  ].join('\n')
}

function uiProcessLabelForAssistant(event: EdmoreEvent, fallback: string): string {
  const payload = asRecord(event.payload)
  const role = textOf(payload.role)
  const source = event.source
  if (role === 'planner' || source.includes('planner')) return 'Planning'
  if (role === 'judge' || source.includes('judge')) return 'Judging plan'
  if (role === 'orchestrator' || source.includes('orchestrator')) return 'Routing'
  return fallback
}

function uiEventId(raw: EdmoreEvent, suffix: string): string {
  return `${raw.event_id}:${suffix}`
}

function toUiEvent(raw: EdmoreEvent, type: string, payload: Record<string, unknown>, suffix = type): EdmoreUiEvent {
  return {
    event_id: uiEventId(raw, suffix),
    cursor: raw.cursor,
    timestamp: raw.timestamp,
    source: raw.source,
    type,
    scope: 'ui',
    ...raw.session_id === undefined ? {} : { session_id: raw.session_id },
    ...raw.workflow_id === undefined ? {} : { workflow_id: raw.workflow_id },
    raw_event_id: raw.event_id,
    raw_cursor: raw.cursor,
    payload,
  }
}

function projectUiEvents(raw: EdmoreEvent): EdmoreUiEvent[] {
  const payload = asRecord(raw.payload)
  if (raw.type === 'edmore.assistant.delta') return []
  if (payload.hidden === true && raw.type.startsWith('edmore.assistant.')) {
    if (raw.type === 'edmore.assistant.started') {
      return [toUiEvent(raw, 'edmore.ui.process.started', { label: uiProcessLabelForAssistant(raw, 'Thinking') })]
    }
    if (raw.type === 'edmore.assistant.completed') {
      return [toUiEvent(raw, 'edmore.ui.process.completed', { label: uiProcessLabelForAssistant(raw, 'Done') })]
    }
    return []
  }

  if (raw.type === 'edmore.trigger.requested') {
    return [
      toUiEvent(raw, 'edmore.ui.conversation.user_message', {
        text: textOf(payload.display_text) || textOf(payload.prompt),
        origin: textOf(payload.origin) || raw.source,
      }),
      toUiEvent(raw, 'edmore.ui.process.started', { label: 'Thinking' }, 'thinking'),
    ]
  }
  if (raw.type === 'edmore.assistant.started') {
    return [toUiEvent(raw, 'edmore.ui.process.started', { label: uiProcessLabelForAssistant(raw, 'Thinking') })]
  }
  if (raw.type === 'edmore.assistant.completed') {
    const text = textOf(payload.text)
    if (text.startsWith('Plan review required before execution.')) return []
    return [
      toUiEvent(raw, 'edmore.ui.conversation.assistant_message', {
        text,
        response_id: textOf(payload.response_id),
        role: textOf(payload.role) || 'assistant',
      }),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Done' }, 'done'),
    ]
  }
  if (raw.type === 'edmore.conversation.updated') {
    return [toUiEvent(raw, 'edmore.ui.conversation.updated', payload)]
  }
  if (raw.type === 'edmore.assistant.failed') {
    return [
      toUiEvent(raw, 'edmore.ui.conversation.assistant_message', {
        text: `Assistant failed: ${textOf(payload.error) || JSON.stringify(payload)}`,
        response_id: textOf(payload.response_id),
        error: true,
      }),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Failed', status: 'failed' }, 'failed'),
    ]
  }
  if (raw.type === 'edmore.plan.generated') {
    return [toUiEvent(raw, 'edmore.ui.process.started', { label: 'Plan generated' })]
  }
  if (raw.type === 'edmore.custom.planning_proposal.requested') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.planning_proposal', payload),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Planning direction waiting for approval' }, 'planning-proposal-process'),
    ]
  }
  if (raw.type === 'edmore.custom.planning_proposal.accepted') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.planning_proposal_cleared', {}),
      toUiEvent(raw, 'edmore.ui.process.started', { label: 'Creating formal plan' }, 'planning-proposal-process'),
    ]
  }
  if (raw.type === 'edmore.custom.planning_proposal.rejected') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.planning_proposal_cleared', {}),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Planning direction rejected' }, 'planning-proposal-process'),
    ]
  }
  if (raw.type === 'edmore.plan.judged') {
    return [toUiEvent(raw, 'edmore.ui.process.updated', { label: `Plan judge: ${textOf(payload.status) || 'pass'}` })]
  }
  if (raw.type === 'edmore.plan.replan_requested') {
    const attempt = typeof payload.attempt === 'number' ? ` ${payload.attempt}/${payload.max_attempts ?? '?'}` : ''
    return [
      toUiEvent(raw, 'edmore.ui.workflow.replan_requested', { workflow_id: raw.workflow_id, ...payload }),
      toUiEvent(raw, 'edmore.ui.process.updated', { label: `Replanning${attempt}`, detail: textOf(payload.summary) }, 'replan-process'),
    ]
  }
  if (raw.type === 'edmore.custom.plan.repair_exhausted') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.plan_blocked', payload),
      toUiEvent(raw, 'edmore.ui.process.completed', {
        label: 'Plan blocked after judge review',
        detail: textOf(asRecord(payload.plan).judge_report),
        status: 'failed',
      }, 'replan-process'),
    ]
  }
  if (raw.type === 'edmore.approval.requested') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.pending_plan', { plan: payload }),
      toUiEvent(raw, 'edmore.ui.conversation.assistant_message', {
        text: planApprovalUiSummary(payload),
        response_id: raw.event_id,
      }, 'summary'),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Plan waiting for approval' }, 'approval-process'),
    ]
  }
  if (raw.type === 'edmore.approval.granted') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.pending_plan_cleared', {}),
      toUiEvent(raw, 'edmore.ui.process.started', { label: 'Plan approved' }, 'approved-process'),
    ]
  }
  if (raw.type === 'edmore.approval.rejected') {
    return [
      toUiEvent(raw, 'edmore.ui.workflow.pending_plan_cleared', {}),
      toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Plan rejected' }, 'rejected-process'),
    ]
  }
  if (raw.type === 'edmore.workflow.started') {
    return [toUiEvent(raw, 'edmore.ui.workflow.started', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.started', { label: 'Workflow started' }, 'process')]
  }
  if (raw.type === 'edmore.workflow.paused') {
    return [toUiEvent(raw, 'edmore.ui.workflow.paused', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.started', { label: 'Workflow paused' }, 'process')]
  }
  if (raw.type === 'edmore.custom.subplan.proposed') {
    return [toUiEvent(raw, 'edmore.ui.workflow.subplan_proposal', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Subplan proposal waiting for approval' }, 'subplan-process')]
  }
  if (raw.type === 'edmore.custom.subplan.accepted') {
    return [toUiEvent(raw, 'edmore.ui.workflow.subplan_accepted', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.started', { label: 'Creating child plan' }, 'subplan-process')]
  }
  if (raw.type === 'edmore.workflow.resumed') {
    return [toUiEvent(raw, 'edmore.ui.workflow.resumed', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.started', { label: 'Workflow resumed' }, 'process')]
  }
  if (raw.type === 'edmore.workflow.completed') {
    return [toUiEvent(raw, 'edmore.ui.workflow.completed', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Workflow completed' }, 'process')]
  }
  if (raw.type === 'edmore.workflow.failed') {
    return [toUiEvent(raw, 'edmore.ui.workflow.failed', { workflow_id: raw.workflow_id, ...payload }), toUiEvent(raw, 'edmore.ui.process.completed', { label: 'Workflow failed', status: 'failed' }, 'process')]
  }
  if (raw.type === 'edmore.custom.harness_tool_call') {
    return [toUiEvent(raw, 'edmore.ui.tool.call', { name: payload.name, arguments: payload.arguments, step: payload.step, turn: payload.turn })]
  }
  if (raw.type === 'edmore.custom.harness_tool_result') {
    return [toUiEvent(raw, 'edmore.ui.tool.result', { call_id: payload.call_id, is_error: payload.is_error, text: payload.text })]
  }
  if (raw.type === 'edmore.hardware.observed') {
    return [toUiEvent(raw, 'edmore.ui.hardware.observed', payload)]
  }
  if (raw.type === 'edmore.custom.harness_tools_synced') {
    return [toUiEvent(raw, 'edmore.ui.status.updated', { area: 'tools' })]
  }
  if (raw.type === 'edmore.llm.provider.updated' || raw.type === 'edmore.llm.provider.selected') {
    return [toUiEvent(raw, 'edmore.ui.status.updated', { area: 'llm' })]
  }
  if (raw.type === 'edmore.server.started' || raw.type === 'edmore.server.stopped') {
    return [toUiEvent(raw, 'edmore.ui.status.updated', { area: 'runtime', status: raw.type })]
  }
  return []
}

function uiEventMatches(event: EdmoreUiEvent, filter: EventFilter): boolean {
  return (filter.after === undefined || event.cursor > filter.after)
    && (filter.session_id === undefined || event.session_id === undefined || event.session_id === filter.session_id)
    && (filter.workflow_id === undefined || event.workflow_id === filter.workflow_id)
    && (filter.server_id === undefined)
}

function queryUiEvents(hub: EdmoreEventHub, filter: EventFilter): EdmoreUiEvent[] {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
  const rawFilter: EventFilter = { ...filter, limit: 1000 }
  delete rawFilter.scope
  const rawEvents = hub.query(rawFilter)
  const projected = rawEvents.flatMap(projectUiEvents).filter(event => uiEventMatches(event, filter))
  return filter.after === undefined ? projected.slice(-limit) : projected.slice(0, limit)
}

async function serveStatic(res: ServerResponse, packageRoot: string, pathname: string): Promise<void> {
  const file = pathname === '/edmore' || pathname === '/edmore/' ? 'index.html' : pathname.replace(/^\/edmore\//, '')
  const target = join(packageRoot, 'static', file)
  try {
    const info = await stat(target)
    if (!info.isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': STATIC_MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    createReadStream(target).pipe(res)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const packageRoot = dirname(import.meta.dirname)
  const skillsRoot = join(dirname(packageRoot), 'skills')
  const hub = new EdmoreEventHub(config.eventLogPath)
  await hub.ready()
  const actions = new EdmoreActionRegistry(hub)
  const nionSwift = new NionSwiftBridge(hub, config.nionSwiftBaseUrl.replace(/\/$/, ''))
  const workflow = ctx.edmorePlanJudge.createWorkflow(hub, nionSwift, skillsRoot, config.planJudgeStatePath, config.planJudgeAutoRepairMaxAttempts)
  await workflow.ready()
  const llmProviders = new EdmoreLlmProviderManager(ctx, hub, config.llmProviderStorePath, {
    provider: config.assistantProvider,
    model: config.assistantModel,
    ...config.assistantReasoningEffort === undefined ? {} : { reasoningEffort: config.assistantReasoningEffort },
    maxTokens: config.assistantMaxTokens,
    timeoutMs: config.assistantTimeoutMs,
  })
  await llmProviders.ready()
  ctx.effect(() => llmProviders.startSyncLoop(), 'edmore.llm-provider-sync')
  const agentRoles = new EdmoreAgentRoleManager(hub, config.agentRoleStorePath, llmProviders, nionSwift)
  await agentRoles.ready()
  const skillContext = new EdmoreSkillContext(ctx, process.cwd())
  const toolBridge = new EdmoreHarnessMcpToolBridge(ctx, hub, nionSwift, workflow)
  const agentLoop = new EdmoreAgentLoopBridge(ctx, hub, agentRoles, workflow)
  workflow.bindRoleRunner(agentLoop)
  ctx.provide('edmoreEvents', hub)
  ctx.provide('edmoreNionSwift', nionSwift)
  ctx.provide('edmoreWorkflow', workflow)
  ctx.provide('edmoreLlmProviders', llmProviders)
  ctx.provide('edmoreAgentRoles', agentRoles)
  ctx.provide('edmoreSkills', skillContext)
  ctx.provide('edmoreAgentLoop', agentLoop)

  await hub.append({ type: 'edmore.server.started', source: 'edmore-harness', scope: 'global', payload: { runtime: 'deepseek-harness-cordis' } })
  await toolBridge.sync().catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))

  const heartbeat = setInterval(() => {
    void nionSwift.observe().catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
    void toolBridge.sync().catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
  }, config.nionSwiftPollMs)
  ctx.effect(() => () => {
    clearInterval(heartbeat)
    void toolBridge.dispose()
    void agentLoop.dispose()
    void hub.append({ type: 'edmore.server.stopped', source: 'edmore-harness', scope: 'global', payload: {} })
  }, 'edmore.lifecycle')

  const routedLegacyTriggers = new Set<string>()
  ctx.effect(() => hub.subscribe((event) => {
    if (isLegacyNionSwiftTrigger(event)) {
      const payload = asRecord(event.payload)
      const legacyKey = `${event.server_id ?? event.source}:${textOf(payload.agent)}:${textOf(payload.event_type)}:${textOf(payload.local_cursor) || event.event_id}`
      if (!routedLegacyTriggers.has(legacyKey)) {
        routedLegacyTriggers.add(legacyKey)
        const routedSessionId = workflow.routeSessionForLegacyTrigger(event)
        const asConfirmation = routedSessionId !== undefined && isLegacyWorkflowConfirmation(event)
        const confirmationContext = asConfirmation ? confirmationContextFromLegacyNionSwiftTrigger(event) : undefined
        void hub.append(withOptionalSession({
          type: 'edmore.trigger.requested',
          source: 'edmore-trigger-router',
          scope: 'workflow',
          ...event.server_id === undefined ? {} : { server_id: event.server_id },
          correlation_id: event.event_id,
          payload: {
            prompt: promptFromLegacyNionSwiftTrigger(event, asConfirmation),
            display_text: displayTextFromLegacyNionSwiftTrigger(event, asConfirmation),
            origin: 'nionswift-mcp',
            legacy_event_id: event.event_id,
            legacy_cursor: event.cursor,
            legacy_event_type: payload.event_type,
            agent: payload.agent,
            ...confirmationContext === undefined ? {} : { confirmation_context: confirmationContext },
          },
        }, routedSessionId)).catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
      }
      return
    }
    if (event.type !== 'edmore.trigger.requested') return
    void (async () => {
      const route = await workflow.handleTrigger(event)
      if (route.action === 'chat') {
        await agentLoop.handleTrigger(event)
        return
      }
      if (route.action === 'execute' && route.executionPrompt !== undefined) {
        await agentLoop.runWorkflow(event, route.executionPrompt, route.workflowId, route.role)
      }
    })().catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
  }), 'edmore.trigger-dispatch')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/edmore',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        if (req.method === 'GET' && url.pathname === '/api/edmore/health') {
          sendJson(res, 200, { ok: true, application: 'edmore-client', runtime: 'deepseek-harness-cordis', nionswift: await nionSwift.status() })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/state') {
          sendJson(res, 200, { ok: true, workflow: workflow.state(), nionswift: await nionSwift.status(), llm: await llmProviders.list() })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/ui/state') {
          const query = eventQuery(req)
          sendJson(res, 200, {
            ok: true,
            session_id: query.session_id,
            runtime: 'deepseek-harness-cordis',
            workflow: workflow.state(),
            nionswift: await nionSwift.status(),
            llm: await llmProviders.list(),
            events: queryUiEvents(hub, query),
          })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/harness/tools') {
          sendJson(res, 200, { ok: true, tools: toolBridge.schemas() })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/skills') {
          const name = url.searchParams.get('name')
          if (name) {
            const skill = await ctx.skills.get(name, { cwd: process.cwd() })
            sendJson(res, 200, { ok: true, skill })
          } else {
            sendJson(res, 200, { ok: true, ...(await skillContext.catalog()) })
          }
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/llm/providers') {
          sendJson(res, 200, { ok: true, ...(await llmProviders.list()) })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/agent-roles') {
          sendJson(res, 200, { ok: true, ...(await agentRoles.list()) })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/agent-roles') {
          sendJson(res, 200, { ok: true, ...(await agentRoles.upsert(await readJsonBody(req) as AgentRoleConfigInput)) })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/llm/providers') {
          const profile = await llmProviders.upsert(await readJsonBody(req) as LlmProviderInput)
          sendJson(res, 200, { ok: true, profile: compactProfile(profile) })
          return
        }
        if (req.method === 'DELETE' && url.pathname === '/api/edmore/llm/providers') {
          const id = url.searchParams.get('id')
          if (!id) throw new Error('id is required')
          await llmProviders.delete(id)
          sendJson(res, 200, { ok: true, ...(await llmProviders.list()) })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/llm/active') {
          const body = await readJsonBody(req)
          await llmProviders.select(stringField(body.provider ?? body.id, 'provider'))
          sendJson(res, 200, { ok: true, ...(await llmProviders.list()) })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/events') {
          sendJson(res, 200, { events: hub.query(eventQuery(req)) })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/events/stream') {
          const query = eventQuery(req)
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          for (const event of hub.query(query)) {
            res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)
          }
          const dispose = hub.subscribe((event) => {
            if (!hub.matches(event, query)) return
            res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)
          })
          req.on('close', dispose)
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/ui/stream') {
          const query = eventQuery(req)
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          for (const event of queryUiEvents(hub, query)) {
            res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)
          }
          const dispose = hub.subscribe((raw) => {
            for (const event of projectUiEvents(raw)) {
              if (!uiEventMatches(event, query)) continue
              res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)
            }
          })
          req.on('close', dispose)
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/events') {
          sendJson(res, 200, { ok: true, event: await hub.append(await readJsonBody(req) as never) })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/nionswift/status') {
          sendJson(res, 200, await nionSwift.status())
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/nionswift/tools') {
          const agent = url.searchParams.get('agent')
          if (!agent) throw new Error('missing agent')
          sendJson(res, 200, await nionSwift.listTools(agent))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/edmore/nionswift/resources') {
          const agent = url.searchParams.get('agent')
          if (!agent) throw new Error('missing agent')
          sendJson(res, 200, await nionSwift.listResources(agent))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/trigger') {
          const body = await readJsonBody(req)
          const prompt = typeof body.prompt === 'string' ? body.prompt : ''
          const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined
          const actionId = typeof body.action_id === 'string' ? body.action_id : randomUUID()
          const { prompt: _prompt, session_id: _sessionId, action_id: _actionId, ...payload } = body
          void _prompt
          void _sessionId
          void _actionId
          const result = await actions.run(actionId, 'trigger', sessionId, async () => ({ event: await workflow.trigger(prompt, sessionId, payload) }))
          sendJson(res, 200, { ok: true, action_id: result.action_id, replayed: result.replayed, ...result.result })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/approve') {
          const body = await readJsonBody(req)
          if (typeof body.workflow_id !== 'string') throw new Error('workflow_id is required')
          const bodySessionId = typeof body.session_id === 'string' ? body.session_id : undefined
          const actionId = typeof body.action_id === 'string' ? body.action_id : randomUUID()
          const result = await actions.run(actionId, 'approve', bodySessionId, async () => {
            const route = await workflow.approve(body.workflow_id as string, bodySessionId)
            if (route.action === 'execute' && route.executionPrompt !== undefined) {
              void agentLoop.runWorkflow({
                event_id: actionId,
                cursor: 0,
                timestamp: new Date().toISOString(),
                source: 'edmore-client-api',
                type: 'edmore.approval.granted',
                scope: 'workflow',
                ...bodySessionId === undefined ? {} : { session_id: bodySessionId },
                workflow_id: body.workflow_id as string,
                payload: {},
              }, route.executionPrompt, route.workflowId, route.role).catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
            }
            return { route: { action: route.action, workflow_id: route.workflowId, role: route.role, message: route.message } }
          })
          sendJson(res, 200, { ok: true, action_id: result.action_id, replayed: result.replayed, ...result.result })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/resume') {
          const body = await readJsonBody(req)
          const bodySessionId = typeof body.session_id === 'string' ? body.session_id : undefined
          const workflowId = typeof body.workflow_id === 'string' ? body.workflow_id : undefined
          const prompt = typeof body.prompt === 'string' ? body.prompt : 'confirm'
          const actionId = typeof body.action_id === 'string' ? body.action_id : randomUUID()
          const result = await actions.run(actionId, 'resume', bodySessionId, async () => {
            const route = await workflow.resume(workflowId, bodySessionId, prompt, undefined, body.confirmation_context)
            if (route.action === 'execute' && route.executionPrompt !== undefined) {
              void agentLoop.runWorkflow({
                event_id: actionId,
                cursor: 0,
                timestamp: new Date().toISOString(),
                source: 'edmore-client-api',
                type: 'edmore.workflow.resumed',
                scope: 'workflow',
                ...bodySessionId === undefined ? {} : { session_id: bodySessionId },
                ...route.workflowId === undefined ? {} : { workflow_id: route.workflowId },
                payload: { prompt },
              }, route.executionPrompt, route.workflowId, route.role).catch(error => ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
            }
            return { route: { action: route.action, workflow_id: route.workflowId, role: route.role, message: route.message } }
          })
          sendJson(res, 200, { ok: true, action_id: result.action_id, replayed: result.replayed, ...result.result })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/edmore/actions/reject') {
          const body = await readJsonBody(req)
          if (typeof body.workflow_id !== 'string') throw new Error('workflow_id is required')
          const bodySessionId = typeof body.session_id === 'string' ? body.session_id : undefined
          const actionId = typeof body.action_id === 'string' ? body.action_id : randomUUID()
          const result = await actions.run(actionId, 'reject', bodySessionId, async () => {
            await workflow.reject(body.workflow_id as string, typeof body.reason === 'string' ? body.reason : undefined, bodySessionId)
            return { rejected: true }
          })
          sendJson(res, 200, { ok: true, action_id: result.action_id, replayed: result.replayed, ...result.result })
          return
        }
        res.writeHead(404)
        res.end()
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'edmore.api')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: config.validationUiPath,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      await serveStatic(res, packageRoot, new URL(req.url ?? '/', 'http://x').pathname)
    },
  }), 'edmore.validation-ui')
}
