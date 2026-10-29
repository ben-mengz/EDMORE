import { createHash } from 'node:crypto'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Keep one immutable contract copy on disk instead of one per primitive step. */
export function encodeWorkflowState(state: unknown): string {
  const table: Record<string, unknown> = {}
  const compact = JSON.parse(JSON.stringify(state, (key, value) => {
    if (key !== 'skill_snapshot' || !value || typeof value !== 'object') return value
    const id = digest(value)
    table[id] = value
    return { $snapshot: id }
  }))
  return JSON.stringify({ ...compact, skill_snapshot_table: table })
}

export function decodeWorkflowState(text: string): unknown {
  const state = JSON.parse(text)
  const table = state.skill_snapshot_table
  if (table === undefined) return state // Existing state files remain readable.
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('Invalid snapshot table')
  for (const [id, value] of Object.entries(table)) {
    if (digest(value) !== id) throw new Error('Workflow snapshot table integrity check failed')
  }
  delete state.skill_snapshot_table
  return JSON.parse(JSON.stringify(state), (key, value) => {
    if (key !== 'skill_snapshot' || !value?.$snapshot) return value
    if (!Object.hasOwn(table, value.$snapshot)) throw new Error('Missing workflow snapshot')
    // Do not alias mutable step copies after hydration.
    return structuredClone(table[value.$snapshot])
  })
}
