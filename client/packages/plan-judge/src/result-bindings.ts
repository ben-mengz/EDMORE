/** Resolve approved references from raw evidence, never the model's compact context. */
export function resolveResultBinding(value: unknown, lookup: (id: string) => unknown): unknown {
  if (Array.isArray(value)) return value.map(item => resolveResultBinding(item, lookup))
  if (value && typeof value === 'object' && '$fallback' in value) {
    const options = (value as { $fallback: unknown[] }).$fallback
    if (!Array.isArray(options) || options.length !== 2) throw new Error('Invalid fallback binding')
    try { return resolveResultBinding(options[0], lookup) }
    catch (error) {
      if (!(error instanceof MissingResult)) throw error
      return resolveResultBinding(options[1], lookup)
    }
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe result binding key')
    return [key, resolveResultBinding(item, lookup)]
  }))
  if (typeof value !== 'string' || !value.startsWith('{{')) return value
  const match = /^\{\{([\w-]+)\.([\w.]+)\}\}$/.exec(value)
  if (!match) throw new Error(`Invalid result binding: ${value}`)
  const result = lookup(match[1]) as Record<string, unknown> | undefined
  if (!result) throw new MissingResult(`Missing result: ${match[1]}`)
  if (result.isError) throw new Error(`Missing or failed result: ${match[1]}`)
  let current = result.structuredContent
  for (const key of match[2].split('.')) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      throw new Error(`Missing result field: ${value}`)
    }
    current = (current as Record<string, unknown>)[key]
  }
  if (current === undefined) throw new Error(`Missing result field: ${value}`)
  return structuredClone(current)
}
class MissingResult extends Error {}
