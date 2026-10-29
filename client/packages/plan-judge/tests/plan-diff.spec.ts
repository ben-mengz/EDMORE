import { expect, it } from 'vitest'
import { planChanges } from '../src/plan-diff.ts'
import type { PendingPlan } from '../src/index.ts'

it('reports exact parameter, order, criteria, and gate changes without an LLM', () => {
  const before = { goal: 'Inspect', steps: [
    { tool_name: 'read', arguments: { count: 1, device: 'sim' }, completion: { criteria: 'ready' }, required_inputs: ['confirm'] },
    { tool_name: 'verify', arguments: {} },
  ] } as unknown as PendingPlan
  const after = structuredClone(before)
  after.steps.reverse()
  after.steps[1].arguments.count = 2
  after.steps[1].completion = { type: 'semantic_judge', criteria: 'stable' }
  const changes = planChanges(before, after).join('\n')
  expect(changes).toContain('Step 1 tool_name: "read" -> "verify"')
  expect(changes).toContain('"count":2')
  expect(changes).toContain('stable')
  expect(changes).toContain('required_inputs')
  expect(planChanges(before, structuredClone(before))).toEqual(['No executable plan changes.'])
})
