export class ModelQueue {
  constructor(concurrency = 1, limit = 32) { this.concurrency = concurrency; this.limit = limit; this.active = 0; this.waiting = []; this.byUser = new Map() }
  async acquire(user, signal) {
    if (signal.aborted) throw new Error('Request cancelled')
    if ((this.byUser.get(user) || 0) >= 2 || this.waiting.length >= this.limit) throw Object.assign(new Error('Model queue is full; try again shortly'), { status: 429 })
    this.byUser.set(user, (this.byUser.get(user) || 0) + 1)
    try {
      await new Promise((resolve, reject) => {
        const entry = { start: () => { signal.removeEventListener('abort', abort); this.active++; resolve() } }
        const abort = () => { this.waiting = this.waiting.filter(x => x !== entry); reject(new Error('Request cancelled')) }
        if (this.active < this.concurrency) entry.start()
        else { signal.addEventListener('abort', abort, { once: true }); this.waiting.push(entry) }
      })
    } catch (error) { this.byUser.set(user, this.byUser.get(user) - 1); throw error }
    let released = false
    return () => {
      if (released) return
      released = true
      this.byUser.set(user, this.byUser.get(user) - 1)
      this.active--
      this.waiting.shift()?.start()
    }
  }
}
