import { expect, it, vi } from 'vitest'
import { ToolPolicyRegistry } from '../src/policy.ts'

it('fails closed without a policy and removes authorization when disposed', async () => {
  const registry = new ToolPolicyRegistry()
  expect(() => registry.require()).toThrow('cannot execute')
  const policy = { beforeLoopToolCall: vi.fn(async () => {}), afterLoopToolResult: vi.fn(async () => {}), handleLoopToolError: vi.fn(async () => {}) }
  const dispose = registry.register(policy)
  expect(registry.require()).toBe(policy)
  expect(() => registry.register(policy)).toThrow('already registered')
  await registry.require().beforeLoopToolCall('session', 'sem', 'acquire', {}, 'call')
  expect(policy.beforeLoopToolCall).toHaveBeenCalledOnce()
  dispose()
  expect(() => registry.require()).toThrow('cannot execute')
})
