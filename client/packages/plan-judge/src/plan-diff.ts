import { isDeepStrictEqual } from 'node:util'
import type { PendingPlan } from './index.ts'

export function planChanges(before: PendingPlan, after: PendingPlan): string[] {
  const changes: string[] = []
  const compare = (label: string, oldValue: unknown, newValue: unknown) => {
    if (!isDeepStrictEqual(oldValue, newValue)) changes.push(`${label}: ${JSON.stringify(oldValue) ?? '(none)'} -> ${JSON.stringify(newValue) ?? '(none)'}`)
  }
  compare('Goal', before.goal, after.goal)
  compare('Summary', before.summary, after.summary)
  compare('Contract mode', before.planning_mode, after.planning_mode)
  for (let i = 0; i < Math.max(before.steps.length, after.steps.length); i++) {
    const oldStep = before.steps[i], newStep = after.steps[i]
    if (!oldStep || !newStep) {
      changes.push(`Step ${i + 1} ${oldStep ? 'removed' : 'added'}: ${JSON.stringify(oldStep ?? newStep)}`)
      continue
    }
    for (const field of ['kind', 'agent', 'tool_name', 'skill', 'goal', 'arguments', 'completion', 'required_inputs', 'confirmation', 'expected_output', 'on_success', 'on_failure', 'on_error', 'max_visits'] as const) {
      compare(`Step ${i + 1} ${field}`, oldStep[field], newStep[field])
    }
  }
  return changes.length ? changes : ['No executable plan changes.']
}
