export class TaskQueues {
  private queues = new Map<string, Promise<unknown>>()
  private pending = new Map<string, Set<AbortController>>()

  isBusy(sessionId: string): boolean { return Boolean(this.pending.get(sessionId)?.size) }

  run<T>(sessionId: string, role: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = JSON.stringify([sessionId, role])
    const controller = new AbortController()
    const pending = this.pending.get(sessionId) ?? new Set<AbortController>()
    this.pending.set(sessionId, pending)
    pending.add(controller)
    const operation = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      controller.signal.throwIfAborted()
      const result = await new Promise<T>((resolve, reject) => {
        const abort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', abort, { once: true })
        // Detach a cancelled task from the scheduling queue even when a model
        // transport ignores abort. Workflow guards quarantine its late results.
        Promise.resolve().then(() => { controller.signal.throwIfAborted(); return task(controller.signal) })
          .then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort))
      })
      controller.signal.throwIfAborted()
      return result
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
