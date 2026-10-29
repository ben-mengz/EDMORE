import { expect, it } from 'vitest'
import { resolveResultBinding } from '../src/result-bindings.ts'
import { EdmoreWorkflow } from './workflow-fixture.ts'

it('binds nested calculation inputs without asking a model to copy numbers', () => {
  const source = { structuredContent: { value: 2e-9, image: { ref: 'opaque' } } }
  expect(resolveResultBinding({ pixel: '{{frame.value}}', refs: ['{{frame.image.ref}}'] }, () => source))
    .toEqual({ pixel: 2e-9, refs: ['opaque'] })
})

it('fails closed on missing evidence, errors, and inherited fields', () => {
  expect(() => resolveResultBinding('{{frame.value}}', () => undefined)).toThrow('Missing')
  expect(() => resolveResultBinding('{{frame.value}}', () => ({ isError: true }))).toThrow('failed')
  expect(() => resolveResultBinding('{{frame.constructor}}', () => ({ structuredContent: {} }))).toThrow('Missing')
})

it('initializes a loop only when its previous result is absent, never failed', () => {
  const binding = { $fallback: ['{{update.value}}', '{{initial.value}}'] }
  expect(resolveResultBinding(binding, id => id === 'initial' ? { structuredContent: { value: 0 } } : undefined)).toBe(0)
  expect(resolveResultBinding(binding, () => ({ structuredContent: { value: 7 } }))).toBe(7)
  expect(() => resolveResultBinding(binding, id => id === 'update' ? { isError: true } : { structuredContent: { value: 0 } })).toThrow('failed')
})

it('resolves the current workflow evidence rather than compacted model context or another run', () => {
  const workflow = new EdmoreWorkflow({} as never, {} as never, '')
  const step = { step_id: '2', skill: 'objective', skill_step_id: 'fit', arguments: { inputs: {} },
    skill_snapshot: { steps: [{ id: 'fit', parameters: { inputs: { mode: 'result', value: { pixel: '{{frame.pixel}}' } } } }] } }
  const plan = { workflow_id: 'run', session_id: 'session', steps: [
    { step_id: '1', skill: 'objective', skill_step_id: 'frame' }, step] } as never
  workflow['recordExecutionContext'](plan, 'tool.result', 'agent', {
    call_id: 'one', result: { structuredContent: { pixel: 1e-9 } },
  }, 'result-one', '1')
  expect(workflow['resolveStepArguments'](plan, step as never)).toEqual({ inputs: { pixel: 1e-9 } })
  workflow['recordExecutionContext'](plan, 'tool.call', 'agent', { call_id: 'two' }, 'call-two', '1')
  expect(() => workflow['resolveStepArguments'](plan, step as never)).toThrow('Missing')
  workflow['recordExecutionContext'](plan, 'tool.result', 'agent', {
    call_id: 'two', result: { structuredContent: { pixel: 2e-9 } },
  }, 'result-two', '1')
  expect(workflow['resolveStepArguments'](plan, step as never)).toEqual({ inputs: { pixel: 2e-9 } })
})
