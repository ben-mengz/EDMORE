import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export async function readHealth(baseUrl) {
  const response = await fetch(`${baseUrl}/api/edmore/health`, { signal: AbortSignal.timeout(4000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = await response.json()
  if (data.ok !== true || data.application !== 'edmore-client') throw new Error('This port is not an EDMORE client')
  return data
}

export class Supervisor extends EventEmitter {
  constructor(config, { launch = spawn, health = readHealth, request = fetch, startupMs = 60000, stopMs = 15000 } = {}) {
    super()
    Object.assign(this, { config, launch, health, request, startupMs, stopMs })
    this.state = { phase: 'stopped', owned: false, mcp: [], error: '', logs: '' }
  }

  get endpoint() { return this.config.baseUrl }

  publish(patch) {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
    return this.state
  }

  async refresh() {
    if (this.polling || this.busy) return this.state
    this.polling = true
    const generation = this.child
    const endpoint = this.config.baseUrl
    try {
      const data = await this.health(this.config.baseUrl)
      if (this.busy || generation !== this.child || endpoint !== this.config.baseUrl) return this.state
      this.publish({ phase: this.child ? 'running' : 'external', owned: Boolean(this.child),
        error: '', nionswift: data.nionswift?.ok === true,
        mcp: [...(data.nionswift?.agents ?? []).filter(name => typeof name === 'string').map(name =>
          this.state.mcp.find(row => row.name === name && row.source !== 'harness') ?? { name, status: 'discovered' }),
          ...this.state.mcp.filter(row => row.source === 'harness')] })
    } catch (error) {
      if (this.busy || generation !== this.child || endpoint !== this.config.baseUrl) return this.state
      this.publish({ phase: this.child ? 'unresponsive' : this.state.phase === 'error' ? 'error' : 'stopped',
        owned: Boolean(this.child), mcp: [], nionswift: false,
        error: this.child ? error.message : this.state.error })
    } finally { this.polling = false }
    return this.state
  }

  async probeMcp() {
    const generation = this.child
    const endpoint = this.endpoint
    const result = await Promise.all(this.state.mcp.filter(row => row.source !== 'harness').map(async row => {
      try {
        const response = await this.request(`${endpoint}/api/edmore/nionswift/tools?agent=${encodeURIComponent(row.name)}`,
          { signal: AbortSignal.timeout(6000) })
        const data = await response.json()
        if (!response.ok || !Array.isArray(data.tools)) throw new Error('MCP tools/list failed')
        return { name: row.name, status: 'reachable', tools: data.tools.length, checkedAt: Date.now() }
      } catch (error) { return { name: row.name, status: 'unavailable', error: error.message } }
    }))
    try {
      const response = await this.request(`${endpoint}/api/edmore/harness/tools`,
        { signal: AbortSignal.timeout(6000) })
      const data = await response.json()
      if (!response.ok || data.ok !== true || !Array.isArray(data.tools)) throw new Error('Harness tool registry unavailable')
      const counts = new Map()
      for (const tool of data.tools) {
        const match = /^mcp__(.+?)__/.exec(tool.name ?? '')
        if (!match || match[1].startsWith('nionswift_')) continue
        counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
      }
      for (const [name, tools] of counts) {
        result.push({ name, source: 'harness', status: 'registered', tools, checkedAt: Date.now() })
      }
    } catch (error) {
      result.push(...this.state.mcp.filter(row => row.source === 'harness')
        .map(row => ({ name: row.name, source: 'harness', status: 'unavailable', error: error.message })))
    }
    if (generation === this.child && endpoint === this.endpoint && ['running', 'external'].includes(this.state.phase)) this.publish({ mcp: result })
    return this.state
  }

  async start() {
    if (this.busy || this.child) return this.state
    this.busy = true
    try {
      try {
        await this.health(this.config.baseUrl)
        return this.publish({ phase: 'external', owned: false, error: '' })
      } catch { /* A stopped service has no health endpoint; the child will report port conflicts. */ }
      this.publish({ phase: 'starting', owned: true, error: '', mcp: [] })
      const child = this.launch(this.config.node, ['--import', 'tsx/esm',
        fileURLToPath(new URL('./backend-runner.mjs', import.meta.url)), this.config.root, this.config.profile, this.config.baseUrl, this.config.pluginPatch ?? ''], {
        cwd: this.config.root,
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_OPTIONS' && key !== 'ELECTRON_RUN_AS_NODE')), ...this.extraEnv },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      })
      this.child = child
      this.exited = new Promise(resolve => {
        const finish = (error) => {
          if (this.child !== child) return
          this.child = undefined
          this.publish({ phase: this.state.phase === 'stopping' ? 'stopped' : 'error', owned: false,
            mcp: [], pid: undefined, error: this.state.phase === 'stopping' ? '' : error })
          resolve()
        }
        child.once('error', error => finish(error.message))
        child.once('exit', (code, signal) => finish(`EDMORE client exited (${signal ?? code})`))
      })
      for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
        this.publish({ logs: (this.state.logs + chunk.toString()).slice(-24000) })
      })
      const deadline = Date.now() + this.startupMs
      while (this.child === child && Date.now() < deadline) {
        try {
          await this.health(this.config.baseUrl)
          if (this.child === child) return this.publish({ phase: 'running', pid: child.pid })
        } catch { /* Boot is not ready until its health endpoint responds. */ }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (this.child === child) this.publish({ phase: 'unresponsive', error: 'EDMORE client startup timed out. Check logs or stop and retry.' })
    } catch (error) {
      this.publish({ phase: 'error', owned: Boolean(this.child), error: error.message })
    } finally { this.busy = false }
    return this.state
  }

  async stop() {
    if (this.busy) throw new Error('EDMORE client is changing state; try again shortly.')
    if (!this.child) return this.state
    this.busy = true
    this.publish({ phase: 'stopping', mcp: [], error: '' })
    let timer
    try {
      const child = this.child
      await new Promise((resolve, reject) => child.send({ type: 'shutdown' }, error => error ? reject(error) : resolve()))
      await Promise.race([this.exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('EDMORE client has not exited; check the logs before retrying.')), this.stopMs)
      })])
    } catch (error) {
      this.publish({ phase: this.child ? 'unresponsive' : 'stopped', error: error.message })
      throw error
    } finally { clearTimeout(timer); this.busy = false }
    return this.state
  }

  async restart() {
    if (!this.child) throw new Error('Only a EDMORE client started by this desktop can be restarted.')
    await this.stop()
    return this.start()
  }
}
