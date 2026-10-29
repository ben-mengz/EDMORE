import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseEnv } from 'node:util'
import {existsSync} from 'node:fs'

export class WeKnora extends EventEmitter {
  constructor(root, { launch = spawn, node = process.platform === 'win32' ? 'node.exe' : '/opt/homebrew/bin/node' } = {}) {
    super()
    this.root = resolve(root, '../../WeKnora-local')
    this.clientRoot=root
    this.node=node
    this.launch = launch
    this.state = { phase: 'stopped', url: 'http://127.0.0.1:8080', logs: '', error: '' }
  }
  publish(patch) { Object.assign(this.state, patch); this.emit('state', this.state); return this.state }
  async environment() {
    try {
      let env=parseEnv(await readFile(join(this.root, 'harness.env'), 'utf8'))
      if(existsSync(join(this.root,'provision.json'))&&env.EDMORE_USER_WIKI!=='1') {
        let ready=false
        try {await this.health();ready=true}catch{}
        if(ready) {await this.portalUrl();env=parseEnv(await readFile(join(this.root,'harness.env'),'utf8'))}
      }
      return env
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; return {} }
  }
  async configure({ apiKey, knowledgeBaseId }) {
    if (typeof apiKey !== 'string' || typeof knowledgeBaseId !== 'string' || /[\r\n"\\]/.test(apiKey + knowledgeBaseId)) throw new Error('Invalid WeKnora configuration')
    const previous = await this.environment()
    const key = apiKey.trim() || previous.WEKNORA_API_KEY || ''
    const next = { ...previous, WEKNORA_BASE_URL: 'http://127.0.0.1:8080', WEKNORA_API_KEY: key, WEKNORA_CAPABILITIES_KB_ID: knowledgeBaseId.trim() }
    await writeFile(join(this.root, 'harness.env'), Object.entries(next).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n')+'\n', { mode: 0o600 })
    return { configured: Boolean(key && knowledgeBaseId.trim()), knowledgeBaseId: knowledgeBaseId.trim() }
  }
  async health() {
    const response = await fetch(`${this.state.url}/health`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok || (await response.json()).status !== 'ok') throw new Error('WeKnora is not ready')
  }
  async refresh() {
    if (this.busy) return this.state
    try {
      await this.health()
      const wiki = await this.wikiStatus().catch(() => ({ phase: 'unavailable' }))
      return this.busy ? this.state : this.publish({ phase: this.child ? 'running' : 'external', wiki })
    } catch { return this.busy ? this.state : this.publish({ phase: this.child || this.state.error ? 'error' : 'stopped', wiki: null }) }
  }
  async wikiStatus() {
    const env = await this.environment()
    const kb = env.WEKNORA_CAPABILITIES_KB_ID
    if (!kb || !env.WEKNORA_API_KEY) return { phase: 'unconfigured' }
    const api = async path => {
      const response = await fetch(`${this.state.url}/api/v1${path}`, {
        headers: { 'X-API-Key': env.WEKNORA_API_KEY }, signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) throw new Error(`Wiki status HTTP ${response.status}`)
      return response.json()
    }
    const base = (await api(`/knowledge-bases/${encodeURIComponent(kb)}`)).data
    if (!base?.indexing_strategy?.wiki_enabled) return { phase: 'disabled' }
    const stats = await api(`/knowledgebase/${encodeURIComponent(kb)}/wiki/stats`)
    let sources = 0, processing = 0, failed = 0
    for (let page = 1; ; page++) {
      const result = await api(`/knowledge-bases/${encodeURIComponent(kb)}/knowledge?source=manual&page_size=100&page=${page}`)
      if (!Array.isArray(result.data)) throw new Error('Invalid source list')
      for (const doc of result.data) {
        if (doc.channel !== 'edmore-capability-sync') continue
        sources++
        if (doc.parse_status === 'failed') failed++
        else if (doc.parse_status !== 'completed') processing++
      }
      if (result.data.length < 100 || page * 100 >= result.total) break
    }
    return { phase: 'enabled', sources, processing, failed, pages: stats.total_pages,
      pending: stats.pending_tasks, issues: stats.pending_issues }
  }
  async wikiUrl() {
    if(existsSync(join(this.root,'provision.json')))return this.portalUrl()
    const env = await this.environment()
    if (!env.WEKNORA_CAPABILITIES_KB_ID) throw new Error('Configure a knowledge base first')
    return `${this.state.url}/platform/knowledge-bases/${encodeURIComponent(env.WEKNORA_CAPABILITIES_KB_ID)}?tab=wiki`
  }
  async portalUrl() {
    await this.health()
    if(this.portalStarting)return this.portalStarting
    this.portalStarting=new Promise((ok,reject)=> {
      const child=this.portal||this.launch(this.node,['--import','tsx/esm',join(this.clientRoot,'scripts/local-wiki-portal.mjs'),this.root],{
        cwd:this.clientRoot,env:{...process.env},stdio:['ignore','ignore','pipe','ipc'],
      })
      const existing=Boolean(this.portal)
      this.portal=child
      const timeout=setTimeout(()=>finish(new Error('Personal Wiki startup timed out')),120000)
      const message=value=>{if(['wiki-portal-ready','wiki-portal-entry'].includes(value?.type))finish(null,value.url)}
      const failed=()=>finish(new Error('Personal Wiki portal failed; check configuration'))
      const finish=(error,url)=>{clearTimeout(timeout);child.off('message',message);child.off('error',failed);child.off('exit',failed);error?reject(error):ok(url)}
      child.on('message',message);child.once('error',failed);child.once('exit',failed)
      child.once('exit',()=>{if(this.portal===child)this.portal=undefined})
      if(existing)child.send({type:'entry'})
    }).finally(()=>{this.portalStarting=undefined})
    return this.portalStarting
  }
  async start() {
    if (this.busy || this.child) return this.state
    this.busy = true
    try {
      try { await this.health(); return this.publish({ phase: 'external', error: '' }) } catch {}
      const env = parseEnv(await readFile(join(this.root, '.env.lite'), 'utf8'))
      this.publish({ phase: 'starting', error: '', logs: '' })
      const child = this.launch(join(this.root, 'WeKnora-lite'), [], { cwd: this.root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child
      this.exited = new Promise(done => {
        const finish = error => {
          if (this.child === child) {
            this.child = undefined
            this.publish({ phase: this.state.phase === 'stopping' ? 'stopped' : 'error', error: error?.message || '' })
          }
          done()
        }
        child.once('error', finish)
        child.once('exit', () => finish())
      })
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => this.publish({ logs: (this.state.logs + chunk.toString()).slice(-16000) }))
      for (let i = 0; i < 120; i++) {
        if (!this.child) throw new Error(this.state.error || 'WeKnora exited; see backend logs')
        try { await this.health(); return this.publish({ phase: 'running' }) } catch {}
        await new Promise(done => setTimeout(done, 500))
      }
      throw new Error('WeKnora startup timed out; see backend logs')
    } catch (error) {
      await this.stop()
      this.publish({ phase: 'error', error: error.message })
      throw error
    } finally { this.busy = false }
  }
  async stop() {
    if(this.portal) {this.portal.kill('SIGTERM');this.portal=undefined}
    if (!this.child) {
      if (this.state.phase === 'external') throw new Error('WeKnora was started outside this app; stop it at its source')
      return this.publish({ phase: 'stopped' })
    }
    const child = this.child
    const wasBusy = this.busy
    this.busy = true
    this.publish({ phase: 'stopping' })
    child.kill('SIGTERM')
    const timer = setTimeout(() => { if (this.child === child) child.kill('SIGKILL') }, 15000)
    try { await this.exited } finally { clearTimeout(timer); this.busy = wasBusy }
    return this.state
  }
}
