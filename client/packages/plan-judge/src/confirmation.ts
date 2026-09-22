import { createHash } from 'node:crypto'

export interface ConfirmationContract {
  scope?: 'initial' | 'each'
  id: string
  title: string
  before_tool: string
  source_tools: string[]
  result_field: string
  fields: string[]
  edit_tool: string
  names_argument: string
  values_argument: string
}

export interface ConfirmationObservation {
  version: string
  values: Record<string, unknown>
  call_id: string
}

export function confirmationObservation(spec: ConfirmationContract, result: Record<string, unknown>, callId: string): ConfirmationObservation | undefined {
  let data: any = result.structuredContent
  if (!data) for (const block of Array.isArray(result.content) ? result.content : []) {
    try { data = JSON.parse(block.text) } catch { continue }
    if (data && typeof data === 'object') break
  }
  for (const key of spec.result_field.split('.')) data = data?.[key]
  if (!data || typeof data !== 'object' || spec.fields.some(key => data[key] === undefined || data[key] === null)) return undefined
  const values = Object.fromEntries(spec.fields.map(key => [key, data[key]]))
  return { values, call_id: callId, version: createHash('sha256').update(JSON.stringify({ callId, values })).digest('hex') }
}

export function validateConfirmations(value: unknown): ConfirmationContract[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('confirmation_steps must be an array')
  const ids = new Set<string>()
  for (const spec of value) {
    if (!spec || typeof spec.id !== 'string' || ids.has(spec.id) || !spec.title ||
      (spec.scope !== undefined && !['initial', 'each'].includes(spec.scope)) ||
      !/^agent_\w+\.\w+$/.test(spec.before_tool) || !/^agent_\w+\.\w+$/.test(spec.edit_tool) ||
      !Array.isArray(spec.source_tools) || !spec.source_tools.length || spec.source_tools.some((tool: string) => !/^agent_\w+\.\w+$/.test(tool)) ||
      !Array.isArray(spec.fields) || !spec.fields.length || spec.fields.some((field: string) => !/^\w+$/.test(field)) ||
      !/^\w+(\.\w+)*$/.test(spec.result_field) || !/^\w+$/.test(spec.names_argument) || !/^\w+$/.test(spec.values_argument)) throw new Error('Invalid confirmation step contract')
    ids.add(spec.id)
  }
  return value
}
