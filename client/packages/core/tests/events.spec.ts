import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EdmoreEventHub, EdmoreActionRegistry } from '../src/events.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'edmore-events-'))
  directories.push(directory)
  const path = join(directory, 'events.jsonl')
  const hub = new EdmoreEventHub(path)
  await hub.ready()
  return { hub, path }
}

describe('Core event extraction', () => {
  it('checks canonical request fingerprints when an action id is reused', async () => {
    const { hub, path } = await fixture()
    const execute = vi.fn(async () => true)
    await new EdmoreActionRegistry(hub).run('payload-identity', 'trigger', 'one', execute, { a: 1, b: 2 })
    const restored = new EdmoreActionRegistry(new EdmoreEventHub(path))
    expect((await restored.run('payload-identity', 'trigger', 'one', execute, { b: 2, a: 1 })).replayed).toBe(true)
    await expect(restored.run('payload-identity', 'trigger', 'one', execute, { a: 3, b: 2 })).rejects.toThrow('request payload')
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('does not label a successful action failed when its completion receipt cannot be saved', async () => {
    const { hub, path } = await fixture()
    const append = hub.append.bind(hub)
    const spy = vi.spyOn(hub, 'append').mockImplementation(input => {
      if (input.type === 'edmore.custom.action.completed') return Promise.reject(new Error('disk full'))
      return append(input)
    })
    const execute = vi.fn(async () => 'done')
    try {
      await expect(new EdmoreActionRegistry(hub).run('receipt-failure', 'trigger', 'one', execute)).rejects.toThrow('returned successfully')
      expect(hub.query().map(event => event.type)).toEqual(['edmore.custom.action.accepted'])
      const restored = new EdmoreActionRegistry(new EdmoreEventHub(path))
      await expect(restored.run('receipt-failure', 'trigger', 'one', execute)).rejects.toThrow('outcome is unknown')
      expect(execute).toHaveBeenCalledTimes(1)
    } finally { spy.mockRestore() }
  })
  it('preserves both errors when execution and failure receipt persistence fail', async () => {
    const { hub } = await fixture()
    const append = hub.append.bind(hub)
    const spy = vi.spyOn(hub, 'append').mockImplementation(input => {
      if (input.type === 'edmore.custom.action.failed') return Promise.reject(new Error('disk full'))
      return append(input)
    })
    try {
      const actions = new EdmoreActionRegistry(hub)
      const execute = vi.fn(async () => { throw new Error('tool disconnected') })
      const error = await actions.run('failure-receipt', 'trigger', 'one', execute).catch(error => error)
      expect(error).toBeInstanceOf(AggregateError)
      expect(error.errors.map((item: Error) => item.message)).toEqual(['tool disconnected', 'disk full'])
      await expect(actions.run('failure-receipt', 'trigger', 'one', execute)).rejects.toThrow('outcome is unknown')
      expect(execute).toHaveBeenCalledTimes(1)
    } finally { spy.mockRestore() }
  })
  it('preserves a damaged journal and refuses to execute actions', async () => {
    const { path } = await fixture()
    const body = '{broken journal\n'
    await writeFile(path, body)
    const restored = new EdmoreEventHub(path)
    const execute = vi.fn(async () => true)
    await expect(new EdmoreActionRegistry(restored).run('damaged-log', 'trigger', 'one', execute)).rejects.toThrow('line 1')
    expect(execute).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe(body)
  })
  it('checks action identity and never replays an unresolved accepted action', async () => {
    const { hub, path } = await fixture()
    await hub.append({ type: 'edmore.custom.action.accepted', correlation_id: 'pending-action', session_id: 'one', payload: { action: 'trigger' } })
    const actions = new EdmoreActionRegistry(new EdmoreEventHub(path))
    const execute = vi.fn(async () => true)
    await expect(actions.run('pending-action', 'trigger', 'one', execute)).rejects.toThrow('outcome is unknown')
    await expect(actions.run('pending-action', 'trigger', 'two', execute)).rejects.toThrow('different action or session')
    expect(execute).not.toHaveBeenCalled()
  })
  it('deduplicates concurrent matching actions but rejects identity collisions', async () => {
    const { hub } = await fixture()
    const actions = new EdmoreActionRegistry(hub)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const execute = vi.fn(async () => { await gate; return true })
    const first = actions.run('concurrent-action', 'trigger', 'one', execute)
    const second = actions.run('concurrent-action', 'trigger', 'one', execute)
    await expect(actions.run('concurrent-action', 'cancel', 'one', execute)).rejects.toThrow('different action or session')
    release()
    await Promise.all([first, second])
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('does not publish failed writes and permits recovery without a cursor gap', async () => {
    const { hub, path } = await fixture()
    await mkdir(path)
    const seen: number[] = []
    hub.subscribe(event => { seen.push(event.cursor) })
    await expect(hub.append({ type: 'user.test' })).rejects.toThrow()
    expect(hub.query()).toEqual([])
    expect(seen).toEqual([])
    await rm(path, { recursive: true })
    expect((await hub.append({ type: 'user.test' })).cursor).toBe(1)
    expect(seen).toEqual([1])
  })
  it('isolates throwing subscribers and serializes concurrent commits', async () => {
    const { hub, path } = await fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      hub.subscribe(() => { throw new Error('broken view') })
      hub.subscribe(async () => { throw new Error('broken async view') })
      const seen: number[] = []
      hub.subscribe(event => { seen.push(event.cursor) })
      await Promise.all(Array.from({ length: 8 }, () => hub.append({ type: 'user.test' })))
      await hub.flush()
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      const restored = new EdmoreEventHub(path)
      await restored.ready()
      expect(restored.query()).toEqual(hub.query())
      expect(log).toHaveBeenCalled()
    } finally { log.mockRestore() }
  })
  it('preserves durable events, replay cursors, filters and unsubscribe', async () => {
    const { hub, path } = await fixture()
    const seen: string[] = []
    const dispose = hub.subscribe(event => seen.push(event.event_id))
    const first = await hub.append({ type: 'edmore.trigger.requested', session_id: 'one', payload: { prompt: 'hello' } })
    dispose()
    const second = await hub.append({ type: 'edmore.assistant.completed', session_id: 'two' })
    expect(seen).toEqual([first.event_id])
    await hub.flush()
    const restored = new EdmoreEventHub(path)
    await restored.ready()
    expect(restored.query({ after: first.cursor })).toEqual([second])
    expect(restored.query({ session_id: 'one' })).toEqual([first])
    expect(JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!)).toEqual(first)
  })
  it('does not execute a completed action again after restart', async () => {
    const { hub, path } = await fixture()
    let calls = 0
    const execute = async () => ({ calls: ++calls })
    const actions = new EdmoreActionRegistry(hub)
    await actions.run('action-once', 'trigger', 'one', execute)
    const restored = new EdmoreEventHub(path)
    await restored.ready()
    expect((await new EdmoreActionRegistry(restored).run('action-once', 'trigger', 'one', execute)).replayed).toBe(true)
    expect(calls).toBe(1)
  })
  it('retains rejection of direct hardware actions in custom events', async () => {
    const { hub } = await fixture()
    await expect(hub.append({ type: 'user.test', payload: { action: 'direct_acquire' } })).rejects.toThrow('cannot directly request hardware')
    expect(hub.query()).toEqual([])
  })
})
