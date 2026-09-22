import type { McpConnection } from '@deepseek-ai/dsh-edmore-contracts'
import { CapabilityUnavailableError } from '@deepseek-ai/dsh-edmore-contracts'

export class McpRegistry implements McpConnection {
  private provider?: McpConnection
  register(provider: McpConnection): () => void {
    if (this.provider) throw new Error('MCP connection already registered')
    this.provider = provider
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.provider === provider) this.provider = undefined
    }
  }
  async status(): ReturnType<McpConnection['status']> {
    return this.provider ? this.provider.status() : { ok: false, agents: [], agentInfo: {}, message: 'MCP bridge is disabled' }
  }
  private require(): McpConnection {
    if (!this.provider) throw new CapabilityUnavailableError('edmore-mcp-bridge', 'MCP bridge capability is unavailable')
    return this.provider
  }
  listTools(agent: string) { return this.require().listTools(agent) }
  listResources(agent: string) { return this.require().listResources(agent) }
  readResource(agent: string, uri: string) { return this.require().readResource(agent, uri) }
  callTool(agent: string, name: string, args: Record<string, unknown>, signal: AbortSignal) { return this.require().callTool(agent, name, args, signal) }
}
