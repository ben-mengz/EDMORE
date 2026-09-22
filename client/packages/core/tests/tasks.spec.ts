import { expect, it } from 'vitest'
import { TaskQueues } from '../src/tasks.ts'

it('serializes same-role work, cancels queued work, and permits a later request', async () => {
  const tasks = new TaskQueues()
  const calls: string[] = []
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const first = tasks.run('one', 'orchestrator', async signal => {
    calls.push('first')
    started()
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const second = tasks.run('one', 'orchestrator', async () => { calls.push('second') })
  const results = Promise.allSettled([first, second])
  await ready
  expect(tasks.cancel('one')).toBe(2)
  expect((await results).every(result => result.status === 'rejected')).toBe(true)
  expect(calls).toEqual(['first'])
  await tasks.run('one', 'orchestrator', async () => { calls.push('new') })
  expect(calls).toEqual(['first', 'new'])
  await tasks.dispose()
})
