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
