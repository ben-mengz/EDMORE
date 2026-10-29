import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EdmoreAgentRoleManager, isSettingsNotReadyError, optionalPositiveInteger, providerCompatibleConfig } from '../../runtime/src/services.ts'

it('omits OpenAI effort levels for compatible custom providers without changing OpenAI configuration', () => {
  const config = { provider: 'llm3-hu', model: 'llm3', reasoningEffort: 'low', maxTokens: 2048, timeoutMs: 60000 }
  expect(providerCompatibleConfig(config).reasoningEffort).toBeUndefined()
  const bonsai = providerCompatibleConfig({ ...config, provider: 'bonsai-local', model: 'bonsai-2-27b' })
  expect(bonsai.reasoningEffort).toBeUndefined()
  expect(bonsai.timeoutMs).toBe(600000)
  const strata = providerCompatibleConfig({ ...config, provider: 'strata-local', model: 'qwen3.8-flash-next-iq2_xs', reasoningEffort: 'none' })
  expect(strata.reasoningEffort).toBeUndefined()
  expect(Object.hasOwn(strata, 'reasoningEffort')).toBe(false)
  expect(strata.timeoutMs).toBe(600000)
  expect(providerCompatibleConfig({ ...config, provider: 'openai', model: 'gpt-5-mini' }).reasoningEffort).toBe('low')
})

it('validates provider context-window metadata', () => {
  expect(optionalPositiveInteger(131072, 'contextWindow')).toBe(131072)
  expect(optionalPositiveInteger(undefined, 'contextWindow')).toBeUndefined()
  expect(() => optionalPositiveInteger(0, 'contextWindow')).toThrow('positive integer')
  expect(() => optionalPositiveInteger(65536.5, 'contextWindow')).toThrow('positive integer')
})

it('retries LLM provider synchronization while Harness settings are reloading', () => {
  expect(isSettingsNotReadyError(new Error('settings namespace "llm-pi-ai" is not registered'))).toBe(true)
  expect(isSettingsNotReadyError(new Error('Configuration entry changed during reload'))).toBe(true)
  expect(isSettingsNotReadyError(new Error('permission denied'))).toBe(false)
})

it('applies the conversation model to all roles except MCP-pinned models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-model-'))
  const providers = {
    activeAssistantConfig: async () => ({ provider: 'default', model: 'baseline', maxTokens: 1000, timeoutMs: 10000 }),
    list: async () => ({ profiles: [{ id: 'second', model: 'other' }] }),
  }
  const create = () => new EdmoreAgentRoleManager({ append: async () => ({}) } as never, join(root, 'roles.json'), providers as never, { status: async () => ({ ok: true, agents: ['plain', 'pinned'], agentInfo: { plain: { name: 'plain' }, pinned: { name: 'pinned', provider: 'mcp-provider', model: 'mcp-model' } } }) } as never)
  try {
    const manager = create()
    await manager.setConversationModel('one', 'second', 'other')
    expect((await manager.configFor('orchestrator', 'one')).model).toBe('other')
    expect((await manager.configFor('orchestrator', 'two')).model).toBe('baseline')
    for (const role of ['judge', 'judge@review', 'planner', 'planner@planning', 'orchestrator@intent', 'title_generator', 'executor:plain']) {
      expect((await manager.configFor(role, 'one')).model).toBe('other')
    }
    await manager.upsert({ role: 'judge', provider: 'old-provider', model: 'old-model' })
    expect((await manager.configFor('judge', 'one')).model).toBe('other')
    expect(await manager.configFor('executor:pinned', 'one')).toMatchObject({ provider: 'mcp-provider', model: 'mcp-model' })
    await manager.upsert({ role: 'executor:pinned', provider: 'second', model: 'other' })
    expect(await manager.configFor('executor:pinned', 'one')).toMatchObject({ provider: 'second', model: 'other' })
    await manager.upsert({ role: 'executor:pinned', model: null })
    expect((await manager.configFor('executor:pinned', 'one')).model).toBe('mcp-model')
    expect((await create().configFor('orchestrator', 'one')).model).toBe('other')
    await expect(manager.setConversationModel('one', 'missing', 'unknown')).rejects.toThrow('configured')
    await manager.setConversationModel('one')
    expect((await manager.configFor('orchestrator', 'one')).model).toBe('baseline')
  } finally { await rm(root, { recursive: true, force: true }) }
})
