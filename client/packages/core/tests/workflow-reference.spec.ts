import { expect, it, vi } from 'vitest'
import { installNativeMcpPolicyGuard, ToolPolicyRegistry } from '../src/policy.ts'
import { EdmoreSkillContext } from '../../runtime/src/services.ts'

it('keeps workflow references discoverable with no Workflow Engine', async () => {
  const definition = { name: 'alignment', description: 'Alignment workflow', invocation: { modelInvocable: true }, metadata: { edmore: { authority: 'workflow' } } }
  const context = { skills: { snapshot: async () => ({ complete: true, skills: [definition] }), get: async () => definition } }
  const catalog = await new EdmoreSkillContext(context as never, '/tmp').catalog()
  expect(catalog.skills).toHaveLength(1)
  expect(catalog.skills[0].category).toBe('workflow')
})

it('delegates ordinary MCP permissions without Judge and rejects cancelled calls', async () => {
  let execute: any
  const context = { on: (_name: string, callback: any) => { execute = callback } }
  const registry = new ToolPolicyRegistry()
  installNativeMcpPolicyGuard(context as never, registry)
  const next = vi.fn(async () => ({ value: 'ok' }))
  await execute({ name: 'mcp__tem_twin__align_beam_and_c2' }, next)
  expect(next).toHaveBeenCalledOnce()
  await execute({ name: 'skill_read' }, next)
  expect(next).toHaveBeenCalledTimes(2)
  const dispose = registry.register({ beforeLoopToolCall: vi.fn(), afterLoopToolResult: vi.fn(), handleLoopToolError: vi.fn() })
  await execute({ name: 'mcp__tem_twin__align_beam_and_c2' }, next)
  expect(next).toHaveBeenCalledTimes(3)
  dispose()
  await execute({ name: 'mcp__tem_twin__align_beam_and_c2' }, next)
  const controller = new AbortController()
  controller.abort(new Error('Workflow cancelled'))
  await expect(execute({ name: 'mcp__tem_twin__align_beam_and_c2', signal: controller.signal }, next)).rejects.toThrow('Workflow cancelled')
  expect(next).toHaveBeenCalledTimes(4)
})
