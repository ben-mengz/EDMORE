import { createHash } from 'node:crypto'

export function remotePartition(url) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Use an HTTP(S) server origin without a path or credentials')
  return `persist:edmore-remote-${createHash('sha256').update(parsed.origin).digest('hex').slice(0, 24)}`
}

// Uses the same isolated Electron cookie jar as the remote workspace window.
// No local process management or server shutdown endpoint is used here.
export function createRemoteConnection(Supervisor, remoteOrigin) {
return class RemoteConnection extends Supervisor {
  constructor(config, options = {}) {
    super(config, options)
    remoteOrigin(config.remoteUrl)
    this.state.remote = true
    this.generation = 0
    this.connected = false
  }
  get endpoint() { return remoteOrigin(this.config.remoteUrl) }
  async json(path, body) {
    const response = await this.request(`${this.endpoint}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', Origin: this.endpoint },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (response.status === 401) throw Object.assign(new Error('Sign in to the cloud workspace'), { status: 401 })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    return data
  }
  async refresh() {
    if (!this.connected || this.polling) return this.state
    this.polling = true
    const generation = this.generation
    try {
      const user = await this.json('/auth/me')
      if (user.enabled !== true || typeof user.username !== 'string') throw new Error('This server is not an authenticated EDMORE Harness')
      if (generation !== this.generation) return this.state
      this.publish({ phase: 'external', owned: false, username: user.username, isAdmin: user.isAdmin === true,
        deviceAddress: user.deviceAddress, error: '', remote: true,
        ...(this.state.username !== user.username ? { mcp: [] } : {}) })
    } catch (error) {
      if (generation === this.generation) this.publish({ phase: error.status === 401 ? 'signin' : 'unresponsive',
        error: error.status === 401 ? '' : error.message, mcp: [], username: undefined, isAdmin: false })
    } finally { this.polling = false }
    return this.state
  }
  async start() { this.connected = true; return this.refresh() }
  async stop() {
    this.connected = false
    this.generation++
    return this.publish({ phase: 'stopped', owned: false, mcp: [], error: '', username: undefined, isAdmin: false })
  }
  async restart() { throw new Error('The desktop cannot restart the cloud server') }
  async probeMcp() { if (this.connected && this.state.phase === 'external') return super.probeMcp(); return this.state }
}

}
