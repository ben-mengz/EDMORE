import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { readJson, writeJson, pluginCatalog } from './store.mjs'
import { normalizeMcp, publicMcp } from '../../../../desktop/mcp-settings.mjs'
import { personalTarget, deviceAddress } from './mcp-network.mjs'
import { loadFeatures, featurePackages } from '@edmore/plugin-host'

export class Workers {
  constructor({ root, home, workspace, shared, modelUrl, wiki, tango = false, maxWorkers = 4, admin, isAdmin = async () => false }) {
    Object.assign(this, { root, home, workspace, shared, modelUrl, wiki, tango, maxWorkers, admin, isAdmin })
    this.entries = new Map()
    this.changes = new Map()
    this.idle = setInterval(() => {
      for (const [username, entry] of this.entries) if (!entry.requests && Date.now() - entry.used > 30 * 60_000) void this.stop(username)
    }, 60_000)
    this.idle.unref()
  }
  paths(username) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username)) throw new Error('Invalid user identity')
    return { home: join(this.home, 'auth', 'users', username), workspace: join(this.workspace, username) }
  }
  async plugins(username) {
    const settings = await readJson(join(this.paths(username).home, 'plugins.json'), {})
    const policy = await this.admin?.read()
    const features = new Set((await loadFeatures()).map(p => p.id))
    return pluginCatalog.map(p => {
      const allowed = policy?.plugins[p.id] !== false && (!p.feature || features.has(p.feature)) && (!p.provider || this.shared.some(row => row.id === p.provider)) && (p.id !== 'edmore-wiki' || Boolean(this.wiki))
      return { ...p, allowed, enabled: allowed && (settings[p.id] ?? p.defaultEnabled) }
    })
  }
  async modelEnabled(username, provider) { return (await this.plugins(username)).some(p => p.provider === provider && p.enabled) }
  async mcp(username) {
    const rows = await readJson(join(this.paths(username).home, 'mcp.json'), [])
    const admin = await this.isAdmin(username)
    const managed = (await this.admin.read()).mcp.filter(row => admin || row.scope === 'shared')
    return { rows: rows.map(row => ({ ...publicMcp(row), shadowed: managed.some(item => item.id === row.id) })), shared: managed.map(row => ({ id: row.id, kind: row.kind ?? 'standard', enabled: row.enabled, scope: row.scope ?? 'administrators' })) }
  }
  async setMcp(username, input, peer) {
    const previous = this.changes.get(username) || Promise.resolve()
    const result = previous.then(async () => {
      if (this.applying) throw Object.assign(new Error('Applying server settings; retry shortly'), { status: 409 })
      await this.assertRestartable(username)
      const path = join(this.paths(username).home, 'mcp.json')
      const rows = await readJson(path, [])
      let next
      if (input?.remove === true) next = rows.filter(row => row.id !== input.id)
      else {
        const old = rows.find(row => row.id === input?.id)
        const row = normalizeMcp(input, old, { personal: true })
        const url = new URL(row.url)
        await personalTarget(url, peer)
        // Only the authenticated socket peer can grant a private device target.
        // Never accept this capability from the JSON input or a forwarded header.
        if (url.hostname === deviceAddress(peer)) {
          if (!Object.entries(row.headers).some(([name, value]) => name.toLowerCase() === 'authorization' && /^Bearer \S{24,}$/.test(value))) throw Object.assign(new Error('Device MCP requires a strong Bearer authorization token'), { status: 400 })
          row.deviceAddress = deviceAddress(peer)
        }
        if ((await this.mcp(username)).shared.some(item => item.id === row.id)) throw Object.assign(new Error('This name is managed by the administrator'), { status: 409 })
        if (!old && rows.length >= 20) throw Object.assign(new Error('Maximum 20 MCP connections'), { status: 400 })
        next = [...rows.filter(item => item.id !== row.id), row]
      }
      await writeJson(path, next)
      await this.stop(username)
      return this.mcp(username)
    })
    this.changes.set(username, result.catch(() => {}))
    return result
  }
  async setPlugin(username, id, enabled) {
    const previous = this.changes.get(username) || Promise.resolve()
    const result = previous.then(() => this.updatePlugin(username, id, enabled))
    this.changes.set(username, result.catch(() => {}))
    return result
  }
  async setJevKey(username, apiKey) {
    const previous = this.changes.get(username) || Promise.resolve()
    const result = previous.then(async () => {
      if (this.applying) throw Object.assign(new Error('Administrator is applying settings; try again shortly'), { status: 409 })
      await this.assertRestartable(username)
      const path = join(this.paths(username).home, 'edmore', '.credentials.yaml')
      let credentials = { version: 1, refs: {} }
      try { credentials = parse(await readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      credentials.refs ||= {}
      if (apiKey) credentials.refs.TYPESAFE_API_KEY = apiKey
      else delete credentials.refs.TYPESAFE_API_KEY
      await writeJson(path, credentials)
      await this.stop(username)
    })
    this.changes.set(username, result.catch(() => {}))
    return result
  }
  async jevKeyConfigured(username) {
    try {
      const credentials = parse(await readFile(join(this.paths(username).home, 'edmore', '.credentials.yaml'), 'utf8'))
      return Boolean(credentials?.refs?.TYPESAFE_API_KEY)
    } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  async assertRestartable(username) {
    const entry = this.entries.get(username)
    if (!entry) return
    if (entry.mutations) throw Object.assign(new Error('A request is still in progress'), { status: 409 })
    const runtime = await fetch(`http://127.0.0.1:${(await entry.ready).port}/api/edmore/state`, { headers: { 'x-edmore-worker-token': entry.token }, signal: AbortSignal.timeout(5000) }).then(r => { if (!r.ok) throw new Error('Cannot verify workflow status'); return r.json() })
    if (['planning_proposals', 'pending', 'active', 'paused'].some(key => runtime.workflow?.[key]?.length)) throw Object.assign(new Error('Finish or cancel workflows before changing settings'), { status: 409 })
    const state = await fetch(`http://127.0.0.1:${(await entry.ready).port}/api/edmore/events?limit=10000`, { headers: { 'x-edmore-worker-token': entry.token }, signal: AbortSignal.timeout(5000) }).then(r => { if (!r.ok) throw new Error('Cannot verify runtime status'); return r.json() })
    const active = new Set()
    for (const event of state.events || []) {
      if (event.type === 'edmore.assistant.started') active.add(event.payload?.response_id)
      if (['edmore.assistant.completed', 'edmore.assistant.failed'].includes(event.type)) active.delete(event.payload?.response_id)
    }
    if (active.size) throw Object.assign(new Error('Finish active conversations before changing settings'), { status: 409 })
  }
  async updatePlugin(username, id, enabled) {
    if (this.applying) throw Object.assign(new Error('Administrator is applying settings; try again shortly'), { status: 409 })
    if (!pluginCatalog.some(p => p.id === id) || typeof enabled !== 'boolean') throw Object.assign(new Error('Unknown or administrator-only plugin'), { status: 400 })
    const plugins = await this.plugins(username)
    if (enabled && !plugins.find(p => p.id === id)?.allowed) throw Object.assign(new Error('Plugin is unavailable or disabled by the administrator'), { status: 403 })
    if (!enabled && plugins.find(p => p.id === id)?.provider && !plugins.some(p => p.id !== id && p.provider && p.enabled)) {
      const profiles = await readJson(join(this.paths(username).home, 'edmore/llm-providers.json'), {})
      let credentials = {}
      try { credentials = parse(await readFile(join(this.paths(username).home, 'edmore/.credentials.yaml'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!profiles.profiles?.some(p => p.id === 'openai') || !credentials.refs?.OPENAI_API_KEY) throw Object.assign(new Error('Keep at least one model enabled, or configure your own OpenAI key first'), { status: 409 })
    }
    if (enabled && (await this.admin?.read())?.plugins[id] === false) throw Object.assign(new Error('Plugin disabled by the administrator'), { status: 403 })
    await this.assertRestartable(username)
    const path = join(this.paths(username).home, 'plugins.json')
    const settings = await readJson(path, {})
    await writeJson(path, { ...settings, [id]: enabled })
    await this.stop(username)
  }
  async get(username) {
    await this.changes.get(username)
    if (this.applying) throw Object.assign(new Error('Applying server settings; retry shortly'), { status: 503 })
    const existing = this.entries.get(username)
    if (existing) { existing.used = Date.now(); return existing.ready }
    if (this.entries.size >= this.maxWorkers) throw Object.assign(new Error('All Harness slots are busy. Try again later.'), { status: 503 })
    const entry = { username, token: randomBytes(32).toString('hex'), requests: 0, used: Date.now(), child: null }
    this.entries.set(username, entry)
    entry.ready = this.start(entry).catch(error => {
      entry.child?.kill('SIGTERM')
      if (this.entries.get(username) === entry) this.entries.delete(username)
      throw error
    })
    return entry.ready
  }
  async start(entry) {
    const { home, workspace } = this.paths(entry.username)
    await mkdir(join(home, 'edmore'), { recursive: true, mode: 0o700 })
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    const profilesPath = join(home, 'edmore', 'llm-providers.json')
    const previous = await readJson(profilesPath, {})
    const plugins = await this.plugins(entry.username)
    const settings = Object.fromEntries(plugins.map(p => [p.id, p.enabled]))
    const profiles = this.shared.filter(row => plugins.some(p => p.provider === row.id && p.enabled)).map(({ id, displayName, model, contextWindow }) => ({
      id, displayName, model, contextWindow, baseURL: `${this.modelUrl}/${id}/v1`, api: 'openai-completions',
      apiKeyEnv: id === 'llm3-hu' ? 'EDMORE_HU_LLM_API_KEY' : 'EDMORE_BONSAI_API_KEY',
    }))
    // Only this user's OpenAI configuration is carried forward. Never copy the
    // default account credentials into a tenant home.
    profiles.push(...(previous.profiles || []).filter(p => p.id === 'openai'))
    await writeJson(profilesPath, { ...previous, activeProvider: profiles.some(p => p.id === previous.activeProvider) ? previous.activeProvider : profiles[0]?.id || 'openai', profiles,
      disabledProviders: plugins.filter(p => p.provider && !p.enabled).map(p => p.provider) })
    const credentialsPath = join(home, 'edmore', '.credentials.yaml')
    let credentials = { version: 1, refs: {} }
    try { credentials = parse(await readFile(credentialsPath, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    credentials.refs ||= {}
    credentials.refs.EDMORE_HU_LLM_API_KEY = entry.token
    credentials.refs.EDMORE_BONSAI_API_KEY = entry.token
    const adminUser = await this.isAdmin(entry.username)
    const personalJevKeyConfigured = Boolean(credentials.refs.TYPESAFE_API_KEY)
    const personalMcp = await readJson(join(home, 'mcp.json'), [])
    entry.personalMcp = personalMcp.filter(row => row.enabled)
    const proxiedMcp = personalMcp.map(row => ({ ...row, url: `${this.modelUrl}/mcp/${row.id}`, headers: { Authorization: `Bearer ${entry.token}` } }))
    const configuration = await this.admin?.workerSettings(home, workspace, adminUser, settings, personalJevKeyConfigured, proxiedMcp)
    if (adminUser) {
      if (configuration?.jevEnabled) credentials.refs.TYPESAFE_API_KEY = entry.token
      else delete credentials.refs.TYPESAFE_API_KEY
    }
    // JSON is valid YAML; atomic writes preserve the credentials file permissions.
    await writeJson(credentialsPath, credentials)
    entry.revision = configuration?.revision ?? 0
    const wikiEnv = settings['edmore-wiki'] && this.wiki ? await this.wiki.ensure(entry.username) : {}
    const featureConfig = process.env.EDMORE_FEATURE_CONFIG || join(this.home, 'edmore/features.json')
    const featureState = await readJson(featureConfig, { version: 1, disabled: [] })
    const workerFeatureConfig = join(home, 'feature-policy.json')
    const installed = new Set(featurePackages().map(name => name.replace('@edmore/plugin-', '')))
    await writeJson(workerFeatureConfig, { ...featureState, disabled: [...new Set([...featureState.disabled, ...plugins.filter(p => p.feature && !p.enabled).map(p => p.feature)])].filter(id => installed.has(id)) })
    const env = {
      PATH: process.env.PATH, LANG: process.env.LANG || 'C.UTF-8', HOME: home,
      DSH_HOME: home, EDMORE_WORKSPACE: workspace, EDMORE_AUTH_WORKER: '1',
      EDMORE_FEATURE_CONFIG: workerFeatureConfig,
      ...(process.env.EDMORE_FEATURE_PACKAGES ? { EDMORE_FEATURE_PACKAGES: process.env.EDMORE_FEATURE_PACKAGES } : {}),
      ...(this.tango && settings['edmore-tango'] ? { EDMORE_TANGO_PROXY_URL: `${this.modelUrl}/tango/mcp` } : {}),
      ...(process.env.EDMORE_TANGO_SERVER_NAME ? { EDMORE_TANGO_SERVER_NAME: process.env.EDMORE_TANGO_SERVER_NAME } : {}),
      EDMORE_WORKER_TOKEN: entry.token, EDMORE_CLIENT_HOST: '127.0.0.1', EDMORE_CLIENT_PORT: '0',
      EDMORE_DISABLE_COMPUTER_USE: '1', EDMORE_DISABLE_NIONSWIFT: '1',
      EDMORE_USER_PLAN_JUDGE: settings['edmore-plan-judge'] ? '1' : '0',
      EDMORE_USER_CONVERSATION_TITLE: settings['edmore-conversation-title'] ? '1' : '0',
      ...wikiEnv,
      WEKNORA_PERSONAL_ONLY:'1',
      WEKNORA_PUBLIC_SKILL_ROOTS:JSON.stringify([join(this.root,'skills'),join(home,'admin-skills')]),
      WEKNORA_PERSONAL_MCP_SERVERS:JSON.stringify((await this.mcp(entry.username)).rows.filter(row=>row.enabled&&!row.shadowed).map(row=>row.id)),
      ...(adminUser && configuration?.jevEnabled ? { EDMORE_JEV_PROXY_URL: `${this.modelUrl}/jev` } : {}),
    }
    const log = await open(join(home, 'worker.log'), 'a', 0o600)
    const child = fork(resolve(this.root, 'start.mjs'), configuration ? ['--patch', configuration.path] : [], { cwd: this.root, env, execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', log.fd, log.fd, 'ipc'] })
    entry.child = child
    await log.close()
    child.once('exit', () => { if (this.entries.get(entry.username) === entry) this.entries.delete(entry.username) })
    const port = await new Promise((resolvePort, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Harness startup timed out')) }, 60_000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Harness exited during startup')) })
      child.on('message', message => { if (message.type === 'edmore-worker-listening') { clearTimeout(timeout); resolvePort(message.port) } })
    })
    entry.port = port
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Harness exited during startup')
      const response = await fetch(`http://127.0.0.1:${port}/api/edmore/health`, { headers: { 'x-edmore-worker-token': entry.token }, signal: AbortSignal.timeout(1000) }).catch(() => null)
      if (response?.ok) {
        const workspaceReady = await fetch(`http://127.0.0.1:${port}/api/edmore-workspace/projects`, { headers: { 'x-edmore-worker-token': entry.token }, signal: AbortSignal.timeout(1000) }).catch(() => null)
        if (workspaceReady?.ok) return entry
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('Harness API did not become ready')
  }
  async stop(username) {
    const entry = this.entries.get(username)
    if (!entry) return
    await entry.ready.catch(() => {})
    const child = entry.child
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
        child.kill('SIGTERM')
      })
    }
    if (this.entries.get(username) === entry) this.entries.delete(username)
  }
  async restart(username) {
    if (!this.entries.has(username)) throw Object.assign(new Error('Runtime is not active'), { status: 404 })
    await this.assertRestartable(username)
    await this.stop(username)
    const entry = await this.get(username)
    return { username, revision: entry.revision ?? null, status: 'running' }
  }
  async close() { clearInterval(this.idle); await Promise.all([...this.entries.keys()].map(user => this.stop(user))) }
  async applySettings() {
    if (this.applying) throw Object.assign(new Error('Settings are already being applied'), { status: 409 })
    this.applying = true
    try {
      await Promise.all(this.changes.values())
      for (const entry of this.entries.values()) {
        await entry.ready
        if (entry.mutations) throw Object.assign(new Error(`User ${entry.username} has a request in progress`), { status: 409 })
        const response = await fetch(`http://127.0.0.1:${entry.port}/api/edmore/events?limit=10000`, { headers: { 'x-edmore-worker-token': entry.token }, signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error('Cannot verify runtime status; retry later')
        const active = new Set()
        for (const event of (await response.json()).events || []) {
          if (event.type === 'edmore.assistant.started') active.add(event.payload?.response_id)
          if (['edmore.assistant.completed', 'edmore.assistant.failed'].includes(event.type)) active.delete(event.payload?.response_id)
        }
        if (active.size) throw Object.assign(new Error(`User ${entry.username} has an active conversation. Wait before applying settings.`), { status: 409 })
      }
      await Promise.all([...this.entries.keys()].map(user => this.stop(user)))
    } finally { this.applying = false }
  }
}
