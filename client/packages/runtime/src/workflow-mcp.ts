import { createHash } from 'node:crypto'

// Matches @deepseek-ai/dsh-mcp-client's 64-character public-name contract.
export function nativeMcpToolName(server: string, raw: string): string {
  const joined = `mcp__${server}__${raw}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && joined.length <= 64) return joined
  const hash = createHash('sha256').update(`${server}\0${raw}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

export function workflowToolSchemaName(agent: string, raw: string): string {
  if (!agent.startsWith('agent_mcp_')) return raw
  const server = workflowServerName(agent)
  return nativeMcpToolName(server, raw).slice(`mcp__${server}__`.length)
}

// agent_mcp_<server> addresses an already registered standard MCP namespace.
export function workflowServerName(agent: string): string {
  return agent.startsWith('agent_mcp_') ? agent.slice(10) : `nionswift_${agent}`
}

export function workflowMcpView(legacy: any, schemas: () => Array<any>) {
  const generic = () => schemas().flatMap(tool => {
    const match = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(tool.name)
    return match && !match[1].startsWith('nionswift_')
      ? [{ agent: `agent_mcp_${match[1]}`, name: match[2], description: tool.description, inputSchema: tool.parameters }]
      : []
  })
  return {
    async status() {
      const status = await legacy.status()
      const agents = [...new Set(generic().map(tool => tool.agent))]
      return { ...status, ok: status.ok || agents.length > 0,
        agents: [...status.agents, ...agents],
        agentInfo: { ...status.agentInfo, ...Object.fromEntries(agents.map(name => [name, { name }])) } }
    },
    async listTools(agent: string) {
      return agent.startsWith('agent_mcp_')
        ? { tools: generic().filter(tool => tool.agent === agent) }
        : legacy.listTools(agent)
    },
  }
}
