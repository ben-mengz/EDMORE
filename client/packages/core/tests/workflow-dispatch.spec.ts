import { describe, expect, it } from 'vitest'
import type { RuntimeDispatch } from '../../contracts/src/index.ts'
import { unchangedExecutorDispatch } from '../../runtime/src/workflow-dispatch.ts'

describe('workflow argument repair dispatch', () => {
  const initial: RuntimeDispatch = { workflowId: 'w', role: 'executor:agent_mcp_tem_twin', prompt: '',
    step: { step_id: '4', agent: 'agent_mcp_tem_twin', tool_name: 'centering' } }
  it('redispatches rejected arguments even when the executor ends its response', () => {
    const retry = { ...initial, argumentRepairAttempt: 1 }
    expect(unchangedExecutorDispatch(initial.role, initial, retry)).toBe(false)
    expect(unchangedExecutorDispatch(initial.role, retry, { ...retry, argumentRepairAttempt: 2 })).toBe(false)
  })
  it('still prevents unbounded replay of unchanged steps', () => {
    expect(unchangedExecutorDispatch(`${initial.role}@isolated`, initial, { ...initial })).toBe(true)
    const retry = { ...initial, argumentRepairAttempt: 1 }
    expect(unchangedExecutorDispatch(initial.role, retry, { ...retry })).toBe(true)
  })
})
