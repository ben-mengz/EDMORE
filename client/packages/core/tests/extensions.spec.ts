import { expect, it } from 'vitest'
import { ConversationExtensions } from '../src/extensions.ts'

it('core works without plugins; contributions unregister without leaving guards or assets', () => {
  const registry = new ConversationExtensions()
  expect(registry.list()).toEqual([])
  expect(registry.denial('a', 'tool', {})).toBeUndefined()
  const remove = registry.register({ id: 'test', title: 'Test', state: async () => ({}), update: async () => ({}), asset: async () => undefined,
    prompt: session => session, denial: () => 'denied' })
  expect(registry.list()[0]?.module).toBe('/api/edmore/extensions/test/panel.js')
  expect(registry.prompt('a')).toBe('a')
  expect(registry.denial('a', 'tool', {})).toBe('denied')
  remove()
  expect(registry.get('test')).toBeUndefined()
  expect(registry.prompt('a')).toBe('')
  expect(registry.denial('a', 'tool', {})).toBeUndefined()
})
