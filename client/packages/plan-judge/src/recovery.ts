export interface RecoveryOption {
  id: string
  when: string[]
  description: string
}

export interface RecoveryLoop {
  id: string
  tool: string
  fix_tool: string
  choice_argument: string
  success_field: string
  failures_field: string
  details_field: string
  options: RecoveryOption[]
}

export function resultObject(result: Record<string, unknown>): Record<string, any> {
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as Record<string, any>
  for (const block of Array.isArray(result.content) ? result.content : []) {
    try { const data = JSON.parse(block.text); if (data && typeof data === 'object' && !Array.isArray(data)) return data } catch { /* Non-JSON content is not structured diagnostic evidence. */ }
  }
  return {}
}

export function fieldAt(data: any, path: string): unknown {
  return path.split('.').reduce((value, key) => value?.[key], data)
}

export function recoveryOutcome(loop: RecoveryLoop, result: Record<string, unknown>) {
  const data = resultObject(result)
  const pass = fieldAt(data, loop.success_field)
  const failures = fieldAt(data, loop.failures_field)
  const valid = typeof pass === 'boolean' && Array.isArray(failures) && failures.every(item => typeof item === 'string')
  const failed: string[] = valid ? failures as string[] : []
  const known = new Set(loop.options.flatMap(option => option.when))
  const options = valid && pass === false && failed.length && failed.every(id => known.has(id))
    ? loop.options.filter(option => option.when.some(id => failed.includes(id))) : []
  return { passed: valid && pass === true && failed.length === 0, failures: failed,
    details: fieldAt(data, loop.details_field), options,
    reason: !valid ? 'Required structured diagnostics are missing or invalid.' : failed.length ? `Failed diagnostics: ${failed.join(', ')}` : pass ? 'All declared diagnostics passed.' : 'No mapped recovery is available.' }
}

export function validateRecoveryLoops(value: unknown, tools: string[]): RecoveryLoop[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('recovery_loops must be an array')
  const ids = new Set<string>(), triggers = new Set<string>()
  const path = /^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/
  for (const loop of value) {
    if (!loop || typeof loop.id !== 'string' || !loop.id.trim() || ids.has(loop.id) || triggers.has(loop.tool) ||
      !tools.includes(loop.tool) || !tools.includes(loop.fix_tool) || loop.tool === loop.fix_tool ||
      typeof loop.choice_argument !== 'string' || !/^[a-zA-Z_]\w*$/.test(loop.choice_argument) || ![loop.success_field, loop.failures_field, loop.details_field].every(p => typeof p === 'string' && path.test(p)) ||
      !Array.isArray(loop.options) || !loop.options.length) throw new Error('Invalid recovery loop contract')
    const options = new Set<string>()
    for (const option of loop.options) {
      if (!option || typeof option.id !== 'string' || !/^\w+$/.test(option.id) || ['retry_check', 'stop', 'confirm', 'approve'].includes(option.id) || options.has(option.id) ||
        typeof option.description !== 'string' || !option.description.trim() || !Array.isArray(option.when) || !option.when.length ||
        option.when.some((id: unknown) => typeof id !== 'string' || !id)) throw new Error('Invalid recovery option')
      options.add(option.id)
    }
    ids.add(loop.id); triggers.add(loop.tool)
  }
  return value
}
