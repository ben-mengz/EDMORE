import { isDeepStrictEqual } from 'node:util'

export interface ArgumentDifference {
  path: string
  issue: 'missing' | 'unexpected' | 'changed'
  expected?: unknown
  actual?: unknown
}

// Object key order is irrelevant; array order, types and values remain strict.
export function argumentDifferences(expected: unknown, actual: unknown, path = ''): ArgumentDifference[] {
  if (isDeepStrictEqual(expected, actual)) return []
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object'
    && Array.isArray(expected) === Array.isArray(actual)) {
    const left = expected as Record<string, unknown>
    const right = actual as Record<string, unknown>
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => {
      const child = Array.isArray(expected) ? `${path}[${key}]` : path ? `${path}.${key}` : key
      if (!Object.hasOwn(right, key)) return [{ path: child, issue: 'missing' as const, expected: left[key] }]
      if (!Object.hasOwn(left, key)) return [{ path: child, issue: 'unexpected' as const, actual: right[key] }]
      return argumentDifferences(left[key], right[key], child)
    })
  }
  return [{ path, issue: actual === undefined ? 'missing' : 'changed', expected, actual }]
}
