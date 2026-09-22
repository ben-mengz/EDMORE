export class TaskQueues {
  private queues = new Map<string, Promise<unknown>>()
  private pending = new Map<string, Set<AbortController>>()

  run<T>(sessionId: string, role: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = JSON.stringify([sessionId, role])
    const controller = new AbortController()
    const pending = this.pending.get(sessionId) ?? new Set<AbortController>()
    this.pending.set(sessionId, pending)
    pending.add(controller)
    const operation = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => {
      controller.signal.throwIfAborted()
      return task(controller.signal)
    })
    this.queues.set(key, operation)
    return operation.finally(() => {
      pending.delete(controller)
      if (!pending.size) this.pending.delete(sessionId)
      if (this.queues.get(key) === operation) this.queues.delete(key)
    })
  }

  cancel(sessionId: string): number {
    const pending = this.pending.get(sessionId)
    for (const controller of pending ?? []) controller.abort(new Error('Task cancelled by user; hardware state must be verified separately'))
    return pending?.size ?? 0
  }

  async dispose(): Promise<void> {
    for (const session of this.pending.keys()) this.cancel(session)
    await Promise.allSettled([...this.queues.values()])
  }
}
