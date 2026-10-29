import { expect, it } from 'vitest'
import { TaskQueues } from '../src/tasks.ts'

it('cancellation frees the session queue without waiting for an unresponsive model', async () => {
  const tasks = new TaskQueues()
  let finish!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const stuck = tasks.run('session', 'executor', async () => {
    started()
    await new Promise<void>(resolve => { finish = resolve })
  })
  const rejected = expect(stuck).rejects.toThrow('cancelled')
  await ready
  tasks.cancel('session')
  await rejected
  expect(await tasks.run('session', 'executor', async () => 'new request')).toBe('new request')
  finish()
  await tasks.dispose()
})

it('does not return late success after a task ignored cancellation', async () => {
  const tasks = new TaskQueues()
  let finish!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const operation = tasks.run('session', 'planner', async () => {
    started()
    await new Promise<void>(resolve => { finish = resolve })
    return 'late plan'
  })
  const rejected = expect(operation).rejects.toThrow('cancelled')
  await ready
  tasks.cancel('session')
  finish()
  await rejected
})

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
