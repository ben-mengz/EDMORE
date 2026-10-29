import { expect, it } from 'vitest'
import { EdmoreHarnessMcpToolBridge } from '../../mcp-bridge/src/bridge.ts'
import { ToolPolicyRegistry } from '../src/policy.ts'

it('runs ordinary MCP without Judge and applies a registered policy when present', async () => {
  const definitions = new Map<string, any>()
  const order: string[] = []
  let online = true
  const connection = {
    status: async () => ({ ok: online, agents: ['agent_sem'] }),
    listTools: async () => ({ tools: [{ name: 'acquire', inputSchema: { type: 'object', properties: { dwell: { type: 'number' } } } }] }),
    callTool: async () => { order.push('call'); return { content: [{ type: 'text', text: 'done' }], structuredContent: { completed: true } } },
  }
  const ctx = { tools: { register: (definition: any) => { definitions.set(definition.name, definition); return () => { definitions.delete(definition.name) } }, schemas: () => [...definitions.values()] } }
  const events: string[] = []
  const hub = { append: async (event: any) => { events.push(event.type) } }
  const policy = new ToolPolicyRegistry()
  const bridge = new EdmoreHarnessMcpToolBridge(ctx as never, hub as never, connection as never, policy)
  await bridge.sync()
  expect(definitions.size).toBe(1)
  const tool = [...definitions.values()][0]
  const exec = { callId: 'one', agent: { id: 'native-session' }, signal: new AbortController().signal, concludeTurn: () => { order.push('conclude') } }
  await tool.execute({ dwell: 2 }, exec)
  expect(order).toEqual(['call'])
  order.length = 0
  const disposePolicy = policy.register({
    beforeLoopToolCall: async () => { order.push('before'); return true },
    afterLoopToolResult: async () => { order.push('after') },
    handleLoopToolError: async () => { order.push('error') },
  })
  expect((await tool.execute({ dwell: 2 }, exec)).structuredContent.completed).toBe(true)
  expect(order).toEqual(['before', 'call', 'after', 'conclude'])
  disposePolicy()
  await tool.execute({}, exec)
  const cancelled = new AbortController()
  cancelled.abort(new Error('Workflow cancelled'))
  await expect(tool.execute({}, { ...exec, signal: cancelled.signal })).rejects.toThrow('Workflow cancelled')
  online = false
  await bridge.sync()
  expect(definitions.size).toBe(0)
  expect(events.every(type => type === 'edmore.custom.harness_tools_synced')).toBe(true)
  await bridge.dispose()
})
