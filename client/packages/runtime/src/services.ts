import type { EdmoreEvent } from '@deepseek-ai/dsh-edmore-contracts'
import type { EdmoreEventHub } from '@deepseek-ai/dsh-edmore-core/events'
import type {} from '@deepseek-ai/dsh-edmore-core'
export type { EdmoreEvent } from '@deepseek-ai/dsh-edmore-contracts'
import { randomUUID } from 'node:crypto'
import { unchangedExecutorDispatch, emptyOutputAction } from './workflow-dispatch.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { loadSkillDirectory } from '../../../skill-format.mjs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, AssistantStreamFrame, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type { RoleRunOptions } from '@deepseek-ai/dsh-edmore-contracts'
import { contentText } from '@deepseek-ai/dsh-edmore-contracts/content'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'


export interface Config {
  llmProviderStorePath: string
  agentRoleStorePath: string
  assistantProvider: string
  assistantModel: string
  assistantReasoningEffort?: string
  assistantMaxTokens: number
  assistantTimeoutMs: number
}

export const Config: z<Config> = z.object({
  llmProviderStorePath: z.string().required(),
  agentRoleStorePath: z.string().required(),
  assistantProvider: z.string().default('openai'),
  assistantModel: z.string().default('gpt-5-mini'),
  assistantReasoningEffort: z.string(),
  assistantMaxTokens: z.number().min(1).default(4096),
  assistantTimeoutMs: z.number().min(1000).default(60000),
})



export interface AssistantConfig {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens: number
  timeoutMs: number
}

export interface AgentRoleConfigInput {
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

export interface AgentRoleStore {
  conversations?: Record<string, { provider: string; model: string }>
  roles?: Record<string, Partial<AssistantConfig>>
}

type AgentConfigSource = 'user_role' | 'mcp_agent' | 'backend_default'

export interface ResolvedAgentConfig {
  config: AssistantConfig
  sources: Record<keyof AssistantConfig, AgentConfigSource>
}

export interface NionSwiftAgentInfo {
  name: string
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

export interface LlmProviderProfile {
  id: string
  displayName: string
  baseURL?: string
  model: string
  contextWindow?: number
  embeddingBaseURL?: string
  embeddingModel?: string
  apiKeyEnv?: string
  api?: string
  reasoningEffort?: string
  active?: boolean
}

export interface LlmProviderStore {
  disabledProviders?: string[]
  activeProvider?: string
  profiles?: LlmProviderProfile[]
}

export interface LlmProviderInput {
  id?: unknown
  displayName?: unknown
  base_url?: unknown
  baseURL?: unknown
  model?: unknown
  context_window?: unknown
  contextWindow?: unknown
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

export function isSettingsNotReadyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('settings namespace "llm-pi-ai" is not registered')
    || message.includes('Configuration entry changed during reload')
}

export const DEFAULT_LLM_PROVIDER_PROFILES: LlmProviderProfile[] = [
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

export const DEFAULT_AGENT_ROLE_CONFIGS: Record<string, Partial<AssistantConfig>> = {
  orchestrator: { reasoningEffort: 'low', maxTokens: 2048 },
  planner: { reasoningEffort: 'low', maxTokens: 4096, timeoutMs: 300000 },
  judge: { reasoningEffort: 'low', maxTokens: 4096 },
  executor: { reasoningEffort: 'low', maxTokens: 2048 },
  title_generator: { reasoningEffort: 'low', maxTokens: 128 },
}




export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export function compactAssistantConfig(config: Record<string, unknown>): Partial<AssistantConfig> {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined && value !== '')) as Partial<AssistantConfig>
}

export function providerCompatibleConfig(config: AssistantConfig): AssistantConfig {
  // These OpenAI-compatible endpoints do not expose OpenAI effort levels.
  // Omitting the parameter does not disable their server-side reasoning.
  if (config.provider === 'bonsai-local' || config.provider === 'strata-local') {
    const { reasoningEffort, ...compatible } = config
    return { ...compatible, timeoutMs: Math.max(config.timeoutMs, 600000) }
  }
  if (config.provider === 'llm3-hu') {
    const { reasoningEffort, ...compatible } = config
    return compatible
  }
  return config
}

export function normalizeNionSwiftAgentInfo(value: unknown): NionSwiftAgentInfo | undefined {
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

export function assistantConfigFromAgentInfo(info: NionSwiftAgentInfo | undefined): Partial<AssistantConfig> {
  return compactAssistantConfig({
    ...(info?.provider === undefined ? {} : { provider: info.provider }),
    ...(info?.model === undefined ? {} : { model: info.model }),
    ...(info?.reasoningEffort === undefined ? {} : { reasoningEffort: info.reasoningEffort }),
    ...(info?.maxTokens === undefined ? {} : { maxTokens: info.maxTokens }),
  })
}

export function normalizeRoleId(role: string): string {
  return role.trim().toLowerCase().replace(/\s+/g, '_')
}

export function baseRoleFor(role: string): string {
  return role.startsWith('executor:') ? 'executor' : role.split('@')[0]!
}

export function executorRoleForMcpAgent(agent: string): string {
  return `executor:${agent}`
}

export function roleAllowsMcpAgent(role: string, agent: string): boolean {
  const executionRole = role.split('@')[0]!
  if (executionRole === 'orchestrator') return true
  if (!executionRole.startsWith('executor:')) return false
  return executionRole.slice('executor:'.length) === agent
}

export function allowedToolNamesForRole(role: string, availableNames: string[]): string[] | undefined {
  const executionRole = role.split('@')[0]!
  if (role.includes('@') && !executionRole.startsWith('executor:')) return availableNames.filter(name => ['skill', 'read', 'read_image', 'edmore_read_evidence'].includes(name))
  if (executionRole === 'orchestrator') return undefined
  const baseAllow = availableNames.filter(name => name === 'skill' || name === 'list_subagent_models')
  if (executionRole === 'planner' || executionRole === 'judge') return [...baseAllow, ...availableNames.filter(name => name === 'read' || name === 'read_image')]
  if (!executionRole.startsWith('executor:')) return baseAllow
  const agent = executionRole.slice('executor:'.length)
  const prefix = `mcp__${agent.startsWith('agent_mcp_') ? agent.slice(10) : `nionswift_${agent}`}__`
  return [...baseAllow, ...availableNames.filter(name => name.startsWith(prefix))]
}

export function stringField(value: unknown, name: string): string {
  const text = optionalString(value)
  if (text === undefined) throw new Error(`${name} is required`)
  return text
}

export function defaultCredentialRefForProvider(id: string): string {
  const upper = id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return `EDMORE_${upper}_API_KEY`
}

export function credentialRefName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid credential ref: ${value}`)
  return value
}

export function compactProfile(profile: LlmProviderProfile): LlmProviderProfile {
  return JSON.parse(JSON.stringify(profile)) as LlmProviderProfile
}

export function settingsService(ctx: Context): {
  update(ns: string, patch: Record<string, unknown>): Promise<void>
  replace(ns: string, section: Record<string, unknown>): Promise<void>
} | undefined {
  return ctx.get('settings' as never) as {
    update(ns: string, patch: Record<string, unknown>): Promise<void>
    replace(ns: string, section: Record<string, unknown>): Promise<void>
  } | undefined
}

export function credentialsService(ctx: Context): {
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
    edmoreLlmProviders: EdmoreLlmProviderManager
    edmoreSkills: EdmoreSkillContext
    edmoreAgentLoop: EdmoreAgentLoopBridge
    edmoreToolBridge: { schemas(): unknown[] }
    edmoreClientApi: boolean
  }
}

export class EdmoreSkillContext {
  constructor(private ctx: Context, private cwd: string) {}

  async catalog(): Promise<{ complete: boolean; skills: Array<SkillSummary & { category: string }> }> {
    const snapshot = await this.ctx.skills.snapshot({ cwd: this.cwd })
    const skills: Array<SkillSummary & { category: string }> = []
    for (const summary of snapshot.skills.filter(isModelInvocable)) {
      const definition = await this.ctx.skills.get(summary.name, { cwd: this.cwd })
      if (!definition || !isModelInvocable(definition)) continue
      const metadata = asRecord(definition.metadata)
      const authority = asRecord(metadata.edmore).authority
      let category = authority === 'workflow' ? 'workflow' : 'support'
      if (authority === undefined && definition.path && definition.resourceBase?.kind === 'directory') {
        try { category = (await loadSkillDirectory(dirname(definition.path))).category }
        catch { category = 'unknown' }
      }
      skills.push({ ...summary, category })
    }
    return {
      complete: snapshot.complete,
      skills,
    }
  }

}

export class EdmoreLlmProviderManager {
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
      contextWindow: profile.contextWindow,
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
    const previous = this.profiles().find(profile => profile.id === id)
    const contextWindow = optionalPositiveInteger(input.contextWindow ?? input.context_window, 'contextWindow') ?? previous?.contextWindow
    const baseURL = optionalString(input.baseURL) || optionalString(input.base_url)
    const embeddingBaseURL = optionalString(input.embeddingBaseURL) || optionalString(input.embedding_base_url)
    const embeddingModel = optionalString(input.embeddingModel) || optionalString(input.embedding_model)
    const api = optionalString(input.api) || (id === 'openai' ? undefined : 'openai-completions')
    const explicitApiKeyEnv = optionalString(input.apiKeyEnv) || optionalString(input.api_key_env)
    const apiKey = optionalString(input.apiKey) || optionalString(input.api_key)
    const reasoningEffort = optionalString(input.reasoningEffort) || optionalString(input.reasoning_effort)
    const apiKeyEnv = explicitApiKeyEnv || previous?.apiKeyEnv || defaultCredentialRefForProvider(id)
    if (apiKey) await this.setCredential(apiKeyEnv, apiKey)
    const profile = compactProfile({
      id,
      displayName,
      ...baseURL === undefined ? {} : { baseURL },
      model,
      ...contextWindow === undefined ? {} : { contextWindow },
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
        contextWindow: profile.contextWindow,
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
    return [...merged.values()].filter(profile => !this.store.disabledProviders?.includes(profile.id))
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
          ...profile.contextWindow === undefined ? {} : { contextWindow: profile.contextWindow },
        }],
      }
    }
    try {
      await settings.replace('llm-pi-ai', { providers })
      return true
    } catch (error) {
      if (isSettingsNotReadyError(error)) return false
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

export class EdmoreAgentRoleManager {
  private store: AgentRoleStore = {}
  private readyPromise: Promise<void>

  constructor(
    private hub: EdmoreEventHub,
    private path: string,
    private providers: EdmoreLlmProviderManager,
    private nionSwift: Pick<Context['edmoreNionSwift'], 'status'>,
  ) {
    this.readyPromise = this.load()
  }

  async ready(): Promise<void> {
    await this.readyPromise
  }

  async configFor(role: string, sessionId?: string): Promise<AssistantConfig> {
    const config = (await this.resolve(role)).config
    const override = sessionId ? this.store.conversations?.[sessionId] : undefined
    const executionRole = role.split('@')[0]!
    if (executionRole.startsWith('executor:')) {
      const manual = this.store.roles?.[executionRole]
      if (manual?.model) return providerCompatibleConfig({ ...config, provider: manual.provider ?? override?.provider ?? config.provider, model: manual.model })
      const mcp = assistantConfigFromAgentInfo(await this.requireOnlineExecutorAgent(executionRole))
      if (mcp.model) {
        let provider = mcp.provider
        if (!provider) {
          const matches = (await this.providers.list()).profiles.map(asRecord).filter(profile => profile.model === mcp.model)
          if (matches.length !== 1) throw new Error(`MCP model '${mcp.model}' has no unambiguous provider. Configure this agent model in Settings.`)
          provider = String(matches[0]!.id)
        }
        return providerCompatibleConfig({ ...config, provider, model: mcp.model })
      }
    }
    return providerCompatibleConfig({ ...config, ...override })
  }

  async conversationModel(sessionId: string) {
    await this.ready()
    return { session_id: sessionId, override: this.store.conversations?.[sessionId] ?? null, effective: await this.configFor('orchestrator', sessionId) }
  }

  async setConversationModel(sessionId: string, provider?: string, model?: string) {
    await this.ready()
    if (provider !== undefined) {
      const profiles = await this.providers.list()
      if (!profiles.profiles.some(profile => asRecord(profile).id === provider && asRecord(profile).model === model)) throw new Error('Select a configured provider/model profile')
    }
    this.store.conversations ??= {}
    if (provider && model) this.store.conversations[sessionId] = { provider, model }
    else delete this.store.conversations[sessionId]
    await this.persist()
    return this.conversationModel(sessionId)
  }

  async list(): Promise<{ priority: AgentConfigSource[]; roles: Record<string, AssistantConfig & { sources: Record<keyof AssistantConfig, AgentConfigSource> }> }> {
    await this.ready()
    const status = await this.nionSwift.status()
    const roles: Record<string, AssistantConfig & { sources: Record<keyof AssistantConfig, AgentConfigSource> }> = {}
    for (const role of ['orchestrator', 'planner', 'judge', 'title_generator']) {
      const resolved = await this.resolve(role)
      roles[role] = { ...providerCompatibleConfig(resolved.config), sources: resolved.sources }
    }
    if (status.ok) {
      for (const agent of status.agents) {
        const role = executorRoleForMcpAgent(agent)
        const resolved = await this.resolve(role)
        roles[role] = { ...providerCompatibleConfig(resolved.config), sources: resolved.sources }
      }
    }
    return { priority: ['user_role', 'mcp_agent', 'backend_default'], roles }
  }

  private async resolve(role: string): Promise<ResolvedAgentConfig> {
    await this.ready()
    const base = await this.providers.activeAssistantConfig()
    const executionRole = role.split('@')[0]!
    const baseRole = baseRoleFor(role)
    const backend = { ...base, ...(DEFAULT_AGENT_ROLE_CONFIGS[baseRole] ?? {}) }
    const agentInfo = executionRole.startsWith('executor:') ? await this.requireOnlineExecutorAgent(executionRole) : undefined
    const mcp = assistantConfigFromAgentInfo(agentInfo)
    const user = {
      ...(this.store.roles?.[baseRole] ?? {}),
      ...(this.store.roles?.[executionRole] ?? {}),
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
    const provider = input.model === null ? undefined : optionalString(input.provider) ?? previous.provider
    const model = input.model === null ? undefined : optionalString(input.model) ?? previous.model
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

interface WorkflowRunOptions extends RoleRunOptions {
  workflowRunId?: string
  emptyOutputRetried?: boolean
  maxTokensOverride?: number
  retryToolName?: string
}

export class EdmoreAgentLoopBridge {
  private workflowRuns = new Map<string, string>()
  private handledTriggers = new Set<string>()
  private agents = new Map<string, {
    handle: AgentHandle
    selection: ModelSelectionRef
    configSignature: string
  }>()

  constructor(
    private ctx: Context,
    private hub: EdmoreEventHub,
    private roles: EdmoreAgentRoleManager,
    private scheduling: Context['edmoreScheduling'],
  ) {}

  async handleTrigger(event: EdmoreEvent): Promise<void> {
    if (this.handledTriggers.has(event.event_id)) return
    this.handledTriggers.add(event.event_id)
    const payload = event.payload as { prompt?: unknown } | undefined
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
    if (!prompt) return
    const sessionId = event.session_id ?? 'default'
    const role = 'orchestrator'
    await this.ctx.edmoreTasks.run(sessionId, role, signal => this.runPrompt(sessionId, role, prompt, event, undefined, 0, {}, signal))
  }

  async runWorkflow(sourceEvent: EdmoreEvent, prompt: string, workflowId?: string, role = 'orchestrator'): Promise<void> {
    const sessionId = sourceEvent.session_id ?? 'default'
    const workflowRunId = randomUUID()
    this.workflowRuns.set(sessionId, workflowRunId)
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
    await this.ctx.edmoreTasks.run(sessionId, role, signal => this.runIsolatedWorkflowStep(sessionId, role, prompt, event, workflowId, 0, { workflowRunId }, signal))
  }

  private async runIsolatedWorkflowStep(
    sessionId: string,
    role: string,
    prompt: string,
    event: EdmoreEvent,
    workflowId: string | undefined,
    depth: number,
    options: WorkflowRunOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    const isolatedRole = `${role.split('@')[0]!}@${randomUUID()}`
    try {
      return await this.runPrompt(sessionId, isolatedRole, prompt, event, workflowId, depth, options, signal)
    } finally {
      const key = this.agentKey(sessionId, isolatedRole)
      const entry = this.agents.get(key)
      this.agents.delete(key)
      await entry?.handle.dispose()
    }
  }

  async runRoleOnce(sessionId: string, role: string, prompt: string, event: EdmoreEvent, options: RoleRunOptions = {}): Promise<string> {
    if (Buffer.byteLength(prompt, 'utf8') > 96000) throw new Error('Review input exceeds the 96000-byte safety budget. Reduce the plan or retrieve evidence in pages; no decision was made.')
    if (options.isolated || (!role.includes('@') && ['judge', 'orchestrator', 'planner'].includes(role))) {
      const isolatedRole = `${role}@${randomUUID()}`
      try { return await this.runRoleOnce(sessionId, isolatedRole, prompt, event, { ...options, isolated: false }) }
      finally {
        const key = this.agentKey(sessionId, isolatedRole)
        const entry = this.agents.get(key)
        this.agents.delete(key)
        await entry?.handle.dispose()
      }
    }
    return await this.ctx.edmoreTasks.run(sessionId, role, signal => this.runPrompt(sessionId, role, prompt, event, undefined, 0, options, signal))
  }

  async skillView(sessionId: string, role: string) {
    const { handle } = await this.ensureAgent(sessionId, role)
    return { cwd: handle.agent.session.header.cwd, scope: handle.agent }
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
    options: WorkflowRunOptions = {},
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted()
    const superseded = () => options.workflowRunId !== undefined && this.workflowRuns.get(sessionId) !== options.workflowRunId
    if (superseded()) return ''
    const startingDispatch = workflowId === undefined ? undefined : this.scheduling.next(sessionId, workflowId)
    const entry = await this.ensureAgent(sessionId, role, options)
    const config = await this.roles.configFor(role, sessionId)
    signal?.throwIfAborted()
    if (superseded()) return ''
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
    let toolCalls = 0
    let finishReason: string | undefined
    const disposeStream = this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent !== entry.handle.agent) return
      if (frame.type === 'chunk' && frame.chunk.type === 'finish') finishReason = frame.chunk.reason.kind
      if (superseded() || signal?.aborted) return
      void this.projectAssistantFrame(frame, event, responseId, config, transcript, role, options)
        .catch(error => this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
    })
    const disposeSession = this.ctx.on('session/event', (session, sessionEvent) => {
      if (session !== entry.handle.agent.session) return
      void this.projectSessionEvent(sessionEvent, event, responseId)
        .catch(error => this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error))))
    })
    const cancel = () => entry.handle.agent.cancel({ kind: 'hook', reason: 'EDMORE task cancelled by user' })
    try {
      signal?.throwIfAborted()
      signal?.addEventListener('abort', cancel, { once: true })
      entry.handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      let timedOut = false
      const timeoutMs = workflowId !== undefined && role.startsWith('executor:')
        ? Math.max(config.timeoutMs, 300_000)
        : config.timeoutMs
      const timeout = setTimeout(() => {
        timedOut = true
        entry.handle.agent.cancel({ kind: 'hook', reason: `EDMORE ${role} timed out after ${timeoutMs} ms` })
      }, timeoutMs)
      try {
        await entry.handle.agent.whenIdle()
      } catch (error) {
        if (!timedOut) throw error
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', cancel)
      }
      signal?.throwIfAborted()
      if (timedOut) throw Object.assign(new Error(`EDMORE ${role} timed out after ${timeoutMs} ms`), { code: 'EDMORE_ROLE_TIMEOUT' })
      const outcome = summarizeAssistantOutput(entry.handle.agent.session, firstSeq)
      finalText = outcome.text.trim()
      modelError = outcome.error
      toolCalls = outcome.toolCalls
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
          finish_reason: finishReason,
          tool_calls: toolCalls,
          empty_output_retry: options.emptyOutputRetried === true,
          ...options.hidden === true || superseded() || (!finalText && !outcome.error) ? { hidden: true } : {},
          ...superseded() ? { superseded: true } : {},
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
          ...options.hidden === true || superseded() || signal?.aborted ? { hidden: true } : {},
          ...superseded() || signal?.aborted ? { superseded: true } : {},
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
      signal?.removeEventListener('abort', cancel)
    }
    signal?.throwIfAborted()
    if (superseded()) return ''
    if (modelError !== undefined) throw new Error(modelError)
    const candidateDispatch = workflowId === undefined || depth >= 50
      ? undefined
      : this.scheduling.next(sessionId, workflowId)
    const unchangedExecutorStep = unchangedExecutorDispatch(role, startingDispatch, candidateDispatch)
    const emptyAction = emptyOutputAction({ role, previous: startingDispatch, next: candidateDispatch, text: finalText,
      toolCalls, error: modelError, retried: options.emptyOutputRetried === true, cancelled: signal?.aborted === true, superseded: superseded() })
    if (emptyAction === 'retry' && candidateDispatch) {
      await this.hub.append(withOptionalSession({ type: 'edmore.assistant.completed', source: 'edmore-agent-loop', scope: 'workflow',
        correlation_id: event.event_id, payload: { response_id: randomUUID(), text: 'The model returned no text or tool call. Retrying this step once with reduced context; your confirmation is retained.' },
      }, event.session_id))
      signal?.throwIfAborted()
      if (superseded()) return ''
      return this.runIsolatedWorkflowStep(sessionId, candidateDispatch.role,
        candidateDispatch.retryPrompt ?? candidateDispatch.prompt, event, candidateDispatch.workflowId, depth,
        { ...options, emptyOutputRetried: true,
          ...(finishReason === 'max-tokens' ? { maxTokensOverride: Math.max(config.maxTokens, Math.min(8192, Math.max(4096, config.maxTokens * 2))) } : {}),
          retryToolName: candidateDispatch.retryToolName,
        }, signal)
    }
    if (emptyAction === 'pause' && candidateDispatch) {
      await this.scheduling.pauseEmptyOutput(sessionId, candidateDispatch, event.event_id,
        'Workflow paused: the model returned no text or tool call after one automatic retry. This step was not executed. Your session and prior confirmation are retained. Reply retry to retry this step.')
      return ''
    }
    const dispatch = unchangedExecutorStep ? undefined : candidateDispatch
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
      await this.runIsolatedWorkflowStep(sessionId, dispatch.role, dispatch.prompt, event, dispatch.workflowId, depth + 1,
        { ...options, emptyOutputRetried: false, maxTokensOverride: undefined, retryToolName: undefined }, signal)
    }
    return finalText
  }

  private async ensureAgent(sessionId: string, role: string, options: WorkflowRunOptions = {}): Promise<{
    handle: AgentHandle
    selection: ModelSelectionRef
    configSignature: string
  }> {
    const key = this.agentKey(sessionId, role)
    const baseConfig = await this.roles.configFor(role, sessionId)
    const config = { ...baseConfig, ...(options.maxTokensOverride === undefined ? {} : { maxTokens: options.maxTokensOverride }) }
    const existing = this.agents.get(key)
    const configSignature = JSON.stringify(config)
    if (existing !== undefined && existing.configSignature === configSignature) return existing
    if (existing !== undefined) {
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
        agentCtx.tools.guard(exec => this.ctx.get('edmoreConversationExtensions')?.denial(sessionId, exec.name, exec.arguments))
        agentCtx.systemPrompt.section({
          name: 'edmore:conversation-extensions',
          order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 21,
          text: () => this.ctx.get('edmoreConversationExtensions')?.prompt(sessionId) ?? '',
        })
        const evidence = this.ctx.get('edmoreSessionState') as unknown as { readEvidence(session: string, event?: string, after?: number, offset?: number): unknown } | undefined
        if (evidence && role.includes('@')) {
          agentCtx.tools.register({
            name: 'edmore_read_evidence',
            description: 'Read-only evidence in this conversation. Omit event_id to list 30 references after a version. Supply event_id to read exact JSON in 12000-character pages using offset.',
            parameters: { type: 'object', properties: { event_id: { type: 'string' }, after: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
            output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            execute: async args => {
              const input = asRecord(args)
              return evidence.readEvidence(sessionId, optionalString(input.event_id), Number(input.after ?? 0), Number(input.offset ?? 0))
            },
          })
        }
        const allow = allowedToolNamesForRole(role, agentCtx.tools.schemas().map(schema => schema.name))
        if (allow !== undefined) agentCtx.tools.restrict({ allow })
        if (options.retryToolName) agentCtx.tools.restrict({ allow: [options.retryToolName, 'skill', 'edmore_read_evidence'] })
        agentCtx.on('tools/pre-execute', async (exec, next) => {
          if (options.workflowRunId !== undefined && this.workflowRuns.get(sessionId) !== options.workflowRunId) {
            return { kind: 'deny', reason: 'This executor was superseded by a newer workflow request.' }
          }
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
    const entry = { handle, selection, configSignature }
    this.agents.set(key, entry)
    this.scheduling.bindSession(String(handle.agent.id), sessionId)
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
    role = role.split('@')[0]!
    if (role.startsWith('executor:')) {
      const agent = role.slice('executor:'.length)
      return [
        `You are the EDMORE executor for MCP namespace ${agent}.`,
        'Execute only the approved current step given by the EDMORE workflow plugin.',
        'Call exactly the requested Harness MCP tool when it is available, then stop and report the concrete result.',
        'Do not plan, replan, skip steps, call tools from other MCP namespaces, or continue to a later step by yourself.',
        'If a required input or user confirmation is missing, stop and say what is required.',
      ].join('\n')
    }
    if (role === 'planner') {
      return [
        'You are the EDMORE planner. Convert user goals into grounded PlanReview objects using Workflows, supporting Skills, MCP schemas, and current state.',
        'A Workflow is an executable EDMORE contract. A Skill provides reference guidance only. Legacy skill field names do not change this distinction.',
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
      'Call executable EDMORE definitions Workflows, and knowledge or guidance documents Skills. Workflows remain stored in the compatible Harness skill registry and SKILL.md files; load the matching definition before discussing or planning it.',
      'Distinguish the installed Judge plugin from per-message Workflow mode. When mode is off or Judge is unavailable, use Skills normally with permitted tools, preserving device selection, safety confirmations, prerequisites and result verification. Workflow metadata alone does not require switching modes. Only an available Judge provides Workflow mode: prepare a reviewed plan and wait for separate approval. Never bypass a pending, active or paused plan. Judge failure cancels existing workflows; never continue those as ordinary tool calls. New user requests may use ordinary Skills. Disabling Judge does not grant tool permissions.',
      'Do not claim that hardware has been changed unless an approved MCP tool result proves it.',
      'For destructive, acquisition, server submission, or hardware-changing actions, honor tool permissions and obtain the required user confirmation before acting; normal Skill mode does not remove safety gates. Never interpret a request for an explanation or a draft as execution authorization.',
      'Use English for user-facing replies and status messages. Do not tell users to enable Workflow mode merely to get an answer or follow a Skill. Only report a plan as submitted, approved or executed when the corresponding system result proves it.',
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

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { raw }
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

export function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim().replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized || 'default'
}

export function summarizeAssistantOutput(session: Session, firstSeq: number): { text: string; toolCalls: number; usage?: unknown; error?: string } {
  let text = ''
  let toolCalls = 0
  let usage: unknown
  let error: string | undefined
  for (const event of session.snapshotEvents()) {
    if (event.seq < firstSeq) continue
    if (event.type === 'tool/call') toolCalls += 1
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
    toolCalls,
    ...usage === undefined ? {} : { usage },
    ...error === undefined ? {} : { error },
  }
}

export function withOptionalSession<T extends Omit<Partial<EdmoreEvent>, 'event_id' | 'cursor' | 'timestamp'> & Pick<EdmoreEvent, 'type'>>(
  event: T,
  sessionId: string | undefined,
): T {
  return sessionId === undefined ? event : { ...event, session_id: sessionId }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function isLegacyNionSwiftTrigger(event: EdmoreEvent): boolean {
  if (event.source !== 'nionswift-mcp') return false
  const payload = asRecord(event.payload)
  const targets = payload.targets
  const hasTriggerTarget = Array.isArray(targets) && targets.includes('trigger')
  return event.type === 'edmore.custom.trigger_llm'
    || payload.event_type === 'trigger_llm'
    || (payload.event_type === 'tool_call' && hasTriggerTarget)
}

export function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}

export function legacyNionSwiftFields(event: EdmoreEvent): Record<string, string> {
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

export function isLegacyWorkflowConfirmation(event: EdmoreEvent): boolean {
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

export function confirmationContextFromLegacyNionSwiftTrigger(event: EdmoreEvent): Record<string, unknown> {
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

export function displayTextFromLegacyNionSwiftTrigger(event: EdmoreEvent, asConfirmation: boolean): string {
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

export function promptFromLegacyNionSwiftTrigger(event: EdmoreEvent, asConfirmation = false): string {
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
