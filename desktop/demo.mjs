import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { inspectExternalDemo, stopExternalDemo } from './demo-external.mjs'

export class Demo extends EventEmitter {
  constructor({ launch = spawn, exists = existsSync, startupMs = 300000, stopMs = 60000 } = {}) {
    super()
    Object.assign(this, { launch, exists, startupMs, stopMs })
    this.state = { phase: 'stopped', detail: '', logs: '' }
  }
  publish(patch) {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }
  async refreshExternal(clientRoot) {
    if (this.inspecting || ['starting', 'stopping'].includes(this.state.phase)) return
    this.inspecting = true
    try {
      const externalMcp = this.child && this.state.twin !== 'external' ? null : await inspectExternalDemo(clientRoot)
      this.publish({ externalMcp, externalError: '' })
    } catch (error) {
      this.publish({ externalMcp: null, externalError: error.message })
    } finally { this.inspecting = false }
  }
  async stopExternal(clientRoot, expected) {
    await stopExternalDemo(clientRoot, expected)
    await this.refreshExternal(clientRoot)
  }
  async start(clientRoot, kind = 'asyncroscopy') {
    if (!['asyncroscopy', 'tem'].includes(kind)) throw new Error('Unknown demo type')
    if (this.child) {
      if ((this.state.kind ?? 'asyncroscopy') !== kind) throw new Error('Stop the current demo before switching.')
      if (this.state.phase === 'running') return
      throw new Error('Demo is changing state; stop it before retrying.')
    }
    const root = kind === 'tem'
      ? process.env.EDMORE_TEM_TWIN_ROOT || resolve(clientRoot, '../../TEM_digital_twin/tem_twin_autoscript')
      : process.env.EDMORE_DEMO_ROOT || resolve(clientRoot, '../../asyncroscopy')
    const python = join(root, kind === 'tem' ? '.venv' : '.venv-twin', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    if (!this.exists(python)) throw new Error(`Demo Python environment not found: ${python}`)
    this.publish({ phase: 'starting', kind, detail: 'Preparing demo services', logs: '', twin: null, viewer: null })
    const child = this.launch(python, ['-u', fileURLToPath(new URL(kind === 'tem' ? './tem-demo-runner.py' : './demo-runner.py', import.meta.url)), root], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    this.child = child
    child.stdin.on('error', () => {})
    child.stderr.on('data', chunk => this.publish({ logs: (this.state.logs + chunk).slice(-16000) }))
    let ready, failed
    const started = new Promise((resolve, reject) => { ready = resolve; failed = reject })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      let data
      try { data = JSON.parse(line) } catch { return }
      if (!['starting', 'running', 'error'].includes(data.phase)) return
      this.publish(data)
      if (data.phase === 'running') ready()
      if (data.phase === 'error') failed(new Error(data.detail))
    })
    this.exited = new Promise(resolve => {
      const finish = detail => {
        if (this.child !== child) return
        this.child = undefined
        lines.close()
        const stopping = this.state.phase === 'stopping'
        this.publish({ phase: stopping ? 'stopped' : 'error', detail: stopping ? '' : this.state.phase === 'error' ? this.state.detail : detail })
        failed(new Error(detail))
        resolve()
      }
      child.once('error', error => finish(error.message))
      child.once('exit', code => finish(`Demo runner exited (${code})`))
    })
    const timer = setTimeout(() => failed(new Error('Demo startup timed out')), this.startupMs)
    try { await started }
    catch (error) {
      await this.stop()
      this.publish({ phase: 'error', detail: error.message })
      throw error
    } finally { clearTimeout(timer) }
  }
  async stop() {
    if (!this.child) return
    this.publish({ phase: 'stopping' })
    this.child.stdin.end('stop\n')
    let timer
    try {
      await Promise.race([this.exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Demo cleanup is still running; check logs.')), this.stopMs)
      })])
    } finally { clearTimeout(timer) }
  }
}
