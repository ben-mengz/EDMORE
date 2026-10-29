import type { RuntimeDispatch } from '@deepseek-ai/dsh-edmore-contracts'

export function unchangedExecutorDispatch(role: string, previous?: RuntimeDispatch, next?: RuntimeDispatch): boolean {
  return role.split('@')[0]!.startsWith('executor:')
    && previous !== undefined && next !== undefined
    && previous.workflowId === next.workflowId
    && previous.executionId === next.executionId
    && previous.step.step_id === next.step.step_id
    && (previous.argumentRepairAttempt ?? 0) === (next.argumentRepairAttempt ?? 0)
}

export function emptyOutputAction(input: {
  role: string; previous?: RuntimeDispatch; next?: RuntimeDispatch; text: string;
  toolCalls: number; error?: string; retried: boolean; cancelled: boolean; superseded: boolean;
}): 'retry' | 'pause' | undefined {
  if (input.cancelled || input.superseded || input.error || input.text.trim() || input.toolCalls > 0
    || !unchangedExecutorDispatch(input.role, input.previous, input.next)) return undefined
  return input.retried ? 'pause' : 'retry'
}
