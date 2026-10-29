import type { Context } from '@deepseek-ai/cordis'
import type { EdmoreEventHub } from '@deepseek-ai/dsh-edmore-core/events'
import type {} from '@deepseek-ai/dsh-edmore-core'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ListResourcesResultSchema, ListToolsResultSchema, ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { contentText, projectMcpContent } from '@deepseek-ai/dsh-edmore-contracts/content'
import { asRecord, normalizeNionSwiftAgentInfo, type NionSwiftAgentInfo } from '@deepseek-ai/dsh-edmore-runtime/services'
import { z } from 'zod'
const RawCallToolResultSchema = z.record(z.string(), z.unknown())

function publicToolName(serverName: string, rawName: string): string {
  return `mcp__${serverName}__${rawName}`
}
export class NionSwiftBridge {
  private modelMetadata = new Map<string, { expires: number; value: Partial<NionSwiftAgentInfo> }>()
  constructor(private hub: EdmoreEventHub, private baseUrl: string, private headers: Record<string, string> = {}) {}

  async status(): Promise<{ ok: boolean; agents: string[]; agentInfo: Record<string, NionSwiftAgentInfo>; message: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/agents`, { headers: this.headers, signal: AbortSignal.timeout(5000) })
      if (!response.ok) return { ok: false, agents: [], agentInfo: {}, message: `HTTP ${response.status}` }
      const data = await response.json()
      if (!Array.isArray(data)) return { ok: false, agents: [], agentInfo: {}, message: 'agents response is not a JSON list' }
      const infos = data.map(normalizeNionSwiftAgentInfo).filter((item): item is NionSwiftAgentInfo => item !== undefined)
      for (const key of this.modelMetadata.keys()) if (!infos.some(info => info.name === key)) this.modelMetadata.delete(key)
      for (const info of infos) {
        const metadata = await this.readModelMetadata(info.name)
        Object.assign(info, { ...metadata, ...info })
      }
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

  private async readModelMetadata(agent: string): Promise<Partial<NionSwiftAgentInfo>> {
    const cached = this.modelMetadata.get(agent)
    if (cached && cached.expires > Date.now()) return cached.value
    const value: Partial<NionSwiftAgentInfo> = {}
    let client: Client | undefined
    try {
      client = await this.connectAgent(agent)
      const listing = await client.request({ method: 'resources/list' }, ListResourcesResultSchema, { timeout: 5000 })
      for (const [scheme, field] of [['model', 'model'], ['provider', 'provider'], ['reasoning', 'reasoningEffort']] as const) {
        const uri = `${scheme}://${agent}`
        if (!listing.resources.some(resource => resource.uri === uri)) continue
        const result = await client.request({ method: 'resources/read', params: { uri } }, ReadResourceResultSchema, { timeout: 5000 })
        const text = result.contents.flatMap(content => 'text' in content ? [content.text] : []).join('\n').trim()
        if (text) value[field] = text
      }
    } catch {
      // Optional metadata must not make ordinary MCP tool discovery unavailable.
    } finally { await client?.close().catch(() => {}) }
    this.modelMetadata.set(agent, { value, expires: Date.now() + 30000 })
    return value
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
    const transport = new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp/${encodeURIComponent(agent)}/`), { requestInit: { headers: this.headers } })
    await client.connect(transport as Transport)
    return client
  }
}

export class EdmoreHarnessMcpToolBridge {
  private disposers = new Map<string, Map<string, () => void>>()
  private signatures = new Map<string, string>()
  private syncRunning = false

  constructor(
    private ctx: Context,
    private hub: EdmoreEventHub,
    private nionSwift: Context['edmoreNionSwift'],
    private policy: Context['edmoreToolPolicy'],
  ) {}

  async sync(): Promise<void> {
    if (this.syncRunning) return
    this.syncRunning = true
    try {
      const status = await this.nionSwift.status()
      if (!status.ok) {
        for (const agent of [...this.disposers.keys()]) this.removeAgent(agent)
        return
      }
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
          exec.signal?.throwIfAborted()
          const policy = this.policy.optional()
          const workflowControlled = await policy?.beforeLoopToolCall(exec.agent?.id, agent, rawName, asRecord(args), callId)
          try {
            const result = await this.nionSwift.callTool(
              agent,
              rawName,
              asRecord(args),
              exec.signal,
            )
            exec.signal?.throwIfAborted()
            await policy?.afterLoopToolResult(exec.agent?.id, agent, rawName, callId, result)
            const content = Array.isArray(result.content) ? result.content : []
            if (result.isError === true) throw new Error(contentText(projectMcpContent(content, rawName)))
            if (workflowControlled === true) exec.concludeTurn()
            return {
              content,
              ...result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent },
            }
          } catch (error) {
            await policy?.handleLoopToolError(exec.agent?.id, agent, rawName, callId, error)
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
