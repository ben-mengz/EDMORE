import { describe, expect, it, vi } from 'vitest'
import { RuntimeScheduling } from '../src/scheduling.ts'

describe('runtime scheduling boundary', () => {
  it('allows ordinary session creation without a workflow provider but blocks workflow dispatch', () => {
    const scheduling = new RuntimeScheduling()
    expect(() => scheduling.bindSession('native-session', 'conversation')).not.toThrow()
    expect(() => scheduling.next('conversation', 'approved-plan')).toThrow('unavailable')
  })

  it('preserves dispatch identity and propagates provider failures without fallback', () => {
    const scheduling = new RuntimeScheduling()
    const dispatch = { workflowId: 'parent', role: 'executor', prompt: 'Continue step', step: { step_id: '3', agent: 'sem', tool_name: 'sync' } }
    const provider = { bindSession: vi.fn(), next: vi.fn(() => dispatch) }
    scheduling.register(provider)
    scheduling.bindSession('native-session', 'conversation')
    expect(provider.bindSession).toHaveBeenCalledWith('native-session', 'conversation')
    expect(scheduling.next('conversation', 'child')).toBe(dispatch)
    expect(provider.next).toHaveBeenCalledWith('conversation', 'child')
    provider.next.mockImplementation(() => { throw new Error('state unavailable') })
    expect(() => scheduling.next('conversation', 'child')).toThrow('state unavailable')
  })

  it('rejects competing providers and disposes without removing a later registration', () => {
    const scheduling = new RuntimeScheduling()
    const provider = { bindSession() {}, next() { return undefined } }
    const dispose = scheduling.register(provider)
    expect(() => scheduling.register({ ...provider })).toThrow('already registered')
    dispose()
    scheduling.register(provider)
    dispose()
    expect(scheduling.next('conversation', 'plan')).toBeUndefined()
  })
})
