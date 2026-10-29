import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest, createServer as createHttpsServer } from 'node:https'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { homedir } from 'node:os'
import { parse } from 'yaml'
import { Accounts, SessionStore, extractSessionToken, buildCookieHeader, buildClearCookieHeader, readJson, writeJson, validatePassword } from './store.mjs'
import { Workers } from './workers.mjs'
import { ModelQueue } from './queue.mjs'
import { AdminSettings } from './admin.mjs'
import { relayPersonalMcp, deviceAddress } from './mcp-network.mjs'
import {WikiAccounts} from './wiki-accounts.mjs'
import {wikiRoute} from './wiki-browser.mjs'
import { modelProviderDefinitions, loadFeatures } from '@edmore/plugin-host'

export const name = 'edmore-auth'
const fail = (status, message) => Object.assign(new Error(message), { status })
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
export async function provisionAccountWikis({ accounts, home, wiki }) {
  if (typeof wiki?.ensure !== 'function') return []
  const provisioned = []
  for (const user of await accounts.users.list()) {
    const path = join(home, 'auth', 'users', user.username, 'plugins.json')
    const settings = await readJson(path, {})
    if (!Object.hasOwn(settings, 'edmore-wiki')) await writeJson(path, { ...settings, 'edmore-wiki': true })
    await wiki.ensure(user.username)
    provisioned.push(user.username)
  }
  return provisioned
}
async function body(req, formEncoded = false) {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw fail(413, 'Request too large'); chunks.push(chunk) }
  const text = Buffer.concat(chunks).toString()
  if (formEncoded) return Object.fromEntries(new URLSearchParams(text))
  try { return JSON.parse(text || '{}') } catch { throw fail(400, 'Invalid JSON') }
}
export function relay(req, res, target, headers, data, onHeaders) {
  return new Promise(resolveDone => {
    const url = new URL(target)
    const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json', ...headers, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) },
    }, upstream => {
      const responseHeaders = { 'cache-control': 'no-store', 'content-type': upstream.headers['content-type'] || 'application/json' }
      onHeaders?.(responseHeaders)
      res.writeHead(upstream.statusCode || 502, responseHeaders)
      upstream.pipe(res)
      upstream.on('error', () => res.destroy())
    })
    outgoing.setTimeout(600_000, () => outgoing.destroy(new Error('Upstream timeout')))
    outgoing.on('error', () => { if (!res.headersSent && !res.destroyed) json(res, 502, { error: 'Upstream unavailable' }); else res.destroy() })
    res.once('close', () => { outgoing.destroy(); resolveDone() })
    if (data !== undefined) outgoing.end(data)
    else req.pipe(outgoing)
  })
}
async function loadShared(home) {
  const store = await readJson(join(home, 'edmore/llm-providers.json'), {})
  const credentials = parse(await readFile(join(home, 'edmore/.credentials.yaml'), 'utf8'))
  const defaults = await modelProviderDefinitions()
  const profiles = new Map([...defaults, ...(store.profiles || [])].map(p => [p.id, p]))
  return defaults.filter(p => p.required || (store.profiles || []).some(row => row.id === p.id)).map(({ id, concurrency }) => {
    const profile = profiles.get(id)
    const key = profile && (credentials?.refs?.[profile.apiKeyEnv] || process.env[profile.apiKeyEnv])
    if (!profile?.baseURL || !key) throw new Error(`Administrator must configure ${id} before enabling login`)
    return { ...profile, concurrency: profile.concurrency ?? concurrency, key }
  })
}
export async function startAuthGateway(options = {}) {
  const home = resolve(options.home || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const workspace = resolve(options.workspace || process.env.EDMORE_WORKSPACE || join(home, 'workspaces'))
  const root = resolve(options.root || new URL('../../../', import.meta.url).pathname)
  const port = options.port ?? Number(process.env.EDMORE_CLIENT_PORT || 7380)
  const host = options.host || process.env.EDMORE_CLIENT_HOST || '127.0.0.1'
  let origin = options.origin || process.env.EDMORE_PUBLIC_URL
  if (!origin && host !== '127.0.0.1') throw new Error('EDMORE_PUBLIC_URL is required for network login')
  if (origin) origin = new URL(origin).origin
  const accounts = new Accounts(join(home, 'auth/accounts.json'))
  if (await accounts.users.isEmpty()) throw new Error('Create an administrator with packages/auth/src/cli.mjs before enabling login')
  const sessions = new SessionStore(12 * 3600)
  const shared = options.shared || await loadShared(home)
  const adminSettings = new AdminSettings(root, home)
  const activeFeatures = await loadFeatures()
  const tangoFile = activeFeatures.some(p => p.id === 'tango') && process.env.EDMORE_TANGO_ACCESS_FILE
  const tango = tangoFile ? new (await import('@edmore/plugin-tango/access')).TangoAccess(tangoFile) : undefined
  if (tango) await tango.config()
  const wikiConfiguration=activeFeatures.some(p => p.id === 'wiki') ? process.env.WEKNORA_PROVISION_FILE : undefined
  const wikiSettings=wikiConfiguration?await readJson(wikiConfiguration):undefined
  if (wikiConfiguration && wikiSettings?.nativeAccounts !== true) throw new Error('Authenticated EDMORE requires separate native Wiki accounts')
  const wiki = options.wiki || (wikiConfiguration ? new WikiAccounts({home,configuration:wikiConfiguration}) : undefined)
  const provisionedWikis = await provisionAccountWikis({ accounts, home, wiki })
  if (provisionedWikis.length) console.log(`Personal Wiki accounts ready: ${provisionedWikis.join(', ')}`)
  const sockets = new Map()
  const throttles = new Map()
  const queues = new Map([...shared.map(p => [p.id, new ModelQueue(p.concurrency || (p.id === 'llm3-hu' ? 4 : 1))]), ['jev', new ModelQueue(4)]])
  let workers
  const modelServer = createServer(async (req, res) => {
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    let release
    try {
      const match = /^\/([a-z0-9-]+)\/v1\/chat\/completions$/.exec(req.url || '')
      const entry = [...workers.entries.values()].find(e => req.headers.authorization === `Bearer ${e.token}`)
      if (req.url === '/tango/mcp') {
        const currentUser = entry && (await accounts.users.list()).find(u => u.username === entry.username && !u.disabled)
        if (!tango || !currentUser || !(await workers.plugins(currentUser.username)).some(p => p.id === 'edmore-tango' && p.enabled)) throw fail(403, 'Tango access is unavailable')
        await tango.proxy(req, res, currentUser)
        return
      }
      const mcp = /^\/mcp\/([A-Za-z0-9_-]{1,32})(\/.*)?$/.exec(req.url || '')
      if (entry && mcp) {
        const row = entry.personalMcp?.find(row => row.id === mcp[1])
        if (!row) throw fail(403, 'Unknown personal MCP')
        await relayPersonalMcp(req, res, row, mcp[2] || '')
        return
      }
      if (entry && req.url === '/jev' && req.method === 'POST') {
        if (!(await workers.isAdmin(entry.username))) throw fail(403, 'Administrator proxy only')
        const settings = await adminSettings.read()
        if (!settings.plugins['edmore-jev-decisions'] || !settings.plugins['edmore-plan-judge'] || !settings.jevKey) throw fail(403, 'Jev is not configured')
        const payload = await body(req)
        if (payload.model !== 'jev-latest') throw fail(400, 'Model is not allowed')
        release = await queues.get('jev').acquire(entry.username, controller.signal)
        if (!controller.signal.aborted) await relay(req, res, 'https://api.typesafe.ai/v1/systemone', { authorization: `Bearer ${settings.jevKey}` }, JSON.stringify(payload))
        return
      }
      if (!entry || !match || req.method !== 'POST') throw fail(403, 'Forbidden')
      const provider = shared.find(p => p.id === match[1])
      if (!provider) throw fail(403, 'Provider is not configured')
      if (!await workers.modelEnabled(entry.username, provider.id)) throw fail(403, 'Model plugin is disabled for this user')
      const payload = await body(req)
      if (payload.model !== provider.model) throw fail(400, 'Model is not allowed')
      release = await queues.get(provider.id).acquire(entry.username, controller.signal)
      if (!controller.signal.aborted) await relay(req, res, provider.baseURL.replace(/\/$/, '') + '/chat/completions', { authorization: `Bearer ${provider.key}` }, JSON.stringify(payload))
    } catch (error) { if (!res.headersSent && !res.destroyed) json(res, error.status || 502, { error: { message: error.message } }) }
    finally { release?.() }
  })
  await new Promise((ok, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', ok) })
  workers = new Workers({ root, home, workspace, shared, wiki, tango: Boolean(tango), admin: adminSettings, isAdmin: async username => (await accounts.users.list()).some(u => u.username === username && u.isAdmin && !u.disabled), modelUrl: `http://127.0.0.1:${modelServer.address().port}`, maxWorkers: options.maxWorkers ?? Number(process.env.EDMORE_MAX_USERS || 4) })
  const disconnect = token => { for (const res of sockets.get(token) || []) res.destroy(); sockets.delete(token) }
  const revokeUser = async username => {
    for (const token of sockets.keys()) if (sessions.verify(token)?.user === username) disconnect(token)
    sessions.revokeAllFor(username)
    await workers.stop(username)
  }
  const handler = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    const url = new URL(req.url || '/', origin)
    if (req.headers.host !== new URL(origin).host) throw fail(403, 'Use the configured service address')
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) throw fail(403, 'Cross-origin request rejected')
    const token = extractSessionToken(req.headers.cookie)
    const session = token && sessions.verify(token)
    const user = session && (await accounts.users.list()).find(u => u.username === session.user && !u.disabled)
    const setSessionCookie = value => res.setHeader('set-cookie', value + (origin.startsWith('https:') ? '; Secure' : ''))
    if (url.pathname === '/auth/login' && req.method === 'POST') {
      const key = req.socket.remoteAddress
      const now = Date.now()
      for (const [address, value] of throttles) if (now > value.until) throttles.delete(address)
      const throttle = throttles.get(key) || { count: 0, until: now + 60_000 }
      if (++throttle.count > 10) throw fail(429, 'Too many login attempts; wait one minute')
      throttles.set(key, throttle)
      const formEncoded = req.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded'
      const input = await body(req, formEncoded)
      if (typeof input.username !== 'string' || typeof input.password !== 'string' || input.password.length > 256) throw fail(400, 'Invalid login')
      const verified = await accounts.users.verify(input.username, input.password)
      if (!verified) throw fail(401, 'Invalid username or password')
      if (token) { disconnect(token); sessions.revoke(token) }
      const created = sessions.create(verified.username, verified.isAdmin)
      await accounts.change(store => store.touchLastLogin(verified.username))
      setSessionCookie(buildCookieHeader(created.token, 12 * 3600))
      if (formEncoded) {
        res.writeHead(303, { location: '/edmore/', 'cache-control': 'no-store' }); res.end(); return
      }
      json(res, 200, { ok: true }); return
    }
    if (req.method === 'GET' && ['/login', '/auth/style.css', '/auth/ui.js'].includes(url.pathname)) {
      const filename = url.pathname === '/login' ? 'login.html' : url.pathname.split('/').at(-1)
      res.writeHead(200, { 'content-type': filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' })
      res.end(await readFile(new URL(`../static/${filename}`, import.meta.url))); return
    }
    if (!user) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) json(res, 401, { error: 'Sign in required' })
      else { res.writeHead(302, { location: '/login' }); res.end() }
      return
    }
    if (!sockets.has(token)) sockets.set(token, new Set())
    sockets.get(token).add(res)
    res.once('close', () => { const set = sockets.get(token); set?.delete(res); if (!set?.size) sockets.delete(token) })
    if(await wikiRoute({req,res,url,wiki,user,workers,home,relay,json,fail}))return
    if (url.pathname === '/devices' || url.pathname.startsWith('/auth/tango/')) {
      if (!tango || !(await loadFeatures()).some(p => p.id === 'tango')) throw fail(503, 'Tango access is not configured')
      if (await tango.route({req, res, url, user, users: () => accounts.users.list(), body, json,
        refreshTools: () => workers.entries.has(user.username) ? workers.restart(user.username) : { status: 'ready' }})) return
      throw fail(404, 'Unknown device route')
    }
    if (url.pathname === '/auth/me' && req.method === 'GET') {
      const policy = await adminSettings.read()
      json(res, 200, {
        enabled: true, username: user.username, isAdmin: user.isAdmin, plugins: await workers.plugins(user.username),
        devices: { available: Boolean(tango) && (await loadFeatures()).some(p => p.id === 'tango') },
        wiki: { browser: Boolean(wiki?.browser)&&(await workers.plugins(user.username)).some(p=>p.id==='edmore-wiki'&&p.enabled) },
        deviceAddress: deviceAddress(req.socket.remoteAddress),
        jev: { required: !user.isAdmin, configured: user.isAdmin ? Boolean(policy.jevKey) : await workers.jevKeyConfigured(user.username), available: Boolean(policy.plugins['edmore-plan-judge'] && policy.plugins['edmore-jev-decisions']) },
        queue: Object.fromEntries([...queues].map(([id, q]) => [id, { active: q.active, waiting: q.waiting.length }])),
      }); return
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      sessions.revoke(token); setSessionCookie(buildClearCookieHeader()); json(res, 200, { ok: true });
      disconnect(token); return
    }
    if (url.pathname === '/account' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(await readFile(new URL('../static/account.html', import.meta.url))); return
    }
    if (url.pathname === '/auth/mcp-editor.js' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
      res.end(await readFile(new URL('../../../../desktop/renderer/mcp.js', import.meta.url))); return
    }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/')) {
      if (!user.isAdmin) throw fail(403, 'Administrator required')
      const assets = { '/admin': 'admin.html', '/admin/': 'admin.html', '/admin/app.js': 'admin.js', '/admin/style.css': 'admin.css' }
      if (req.method === 'GET' && assets[url.pathname]) {
        const filename = assets[url.pathname]
        res.writeHead(200, { 'content-type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store' })
        res.end(await readFile(new URL(`../static/${filename}`, import.meta.url))); return
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/settings') {
        json(res, 200, { settings: await adminSettings.view(), workers: [...workers.entries.values()].map(e => ({ username: e.username, revision: e.revision ?? null, status: e.port ? 'running' : 'starting' })) }); return
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/skills') { json(res, 200, await adminSettings.skills.list()); return }
      if (req.method === 'GET' && url.pathname === '/api/admin/connections') {
        const entry = await workers.get(user.username)
        const response = await fetch(`http://127.0.0.1:${entry.port}/api/edmore/harness/tools`, { headers: { 'x-edmore-worker-token': entry.token }, signal: AbortSignal.timeout(10000) })
        if (!response.ok) throw fail(502, 'Cannot inspect runtime tools')
        const data = await response.json()
        json(res, 200, { revision: entry.revision, tools: (data.tools || []).map(tool => ({ name: tool.name, description: tool.description })) }); return
      }
      if (req.method === 'POST') {
        const input = await body(req)
        let result
        if (url.pathname === '/api/admin/plugins') result = await adminSettings.savePlugin(input, user.username)
        else if (url.pathname === '/api/admin/mcp') result = await adminSettings.saveMcp(input, user.username)
        else if (url.pathname === '/api/admin/skills') result = input.remove ? await adminSettings.removeSkill(input.id, user.username) : await adminSettings.saveSkill(input, user.username)
        else if (url.pathname === '/api/admin/skills/parse') result = await adminSettings.skills.parseSupport(input)
        else if (url.pathname === '/api/admin/workers/restart') result = await workers.restart(input.username)
        else if (url.pathname === '/api/admin/apply') { await workers.applySettings(); result = { ok: true } }
        else throw fail(404, 'Not found')
        json(res, 200, result); return
      }
      throw fail(404, 'Not found')
    }
    if (url.pathname === '/auth/password' && req.method === 'POST') {
      const input = await body(req); validatePassword(input.password)
      if (typeof input.currentPassword !== 'string' || !(await accounts.users.verify(user.username, input.currentPassword))) throw fail(403, 'Current password is incorrect')
      await accounts.change(store => store.setPassword(user.username, input.password))
      json(res, 200, { ok: true }); await revokeUser(user.username); return
    }
    if (url.pathname === '/auth/plugins' && req.method === 'POST') {
      const input = await body(req)
      await workers.setPlugin(user.username, input.id, input.enabled)
      json(res, 200, { ok: true }); return
    }
    if (url.pathname === '/auth/mcp') {
      if (req.method === 'GET') { json(res, 200, await workers.mcp(user.username)); return }
      if (req.method === 'POST') { json(res, 200, await workers.setMcp(user.username, await body(req), req.socket.remoteAddress)); return }
      throw fail(405, 'Method not allowed')
    }
    if (url.pathname === '/auth/jev' && req.method === 'POST') {
      if (user.isAdmin) throw fail(403, 'Administrator Jev credentials are managed in Server settings')
      const input = await body(req)
      if (input.clear !== true && (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))) throw fail(400, 'Enter a valid TypeSafe API key')
      await workers.setJevKey(user.username, input.clear === true ? '' : input.apiKey.trim())
      json(res, 200, { ok: true, configured: input.clear !== true }); return
    }
    if (url.pathname === '/auth/users') {
      if (!user.isAdmin) throw fail(403, 'Administrator required')
      if (req.method === 'GET') { json(res, 200, { users: (await accounts.users.list()).map(({ username, isAdmin, disabled, lastLoginAt }) => ({ username, isAdmin, disabled: !!disabled, lastLoginAt, sessions: sessions.onlineCounts().get(username) || 0 })) }); return }
      if (req.method === 'POST') {
        const input = await body(req)
        if (input.action === 'create') {
          validatePassword(input.password)
          await accounts.change(async store => {
            await store.create(input.username, input.password, input.isAdmin === true)
            const path = join(workers.paths(input.username).home, 'plugins.json')
            await writeJson(path, { ...(await readJson(path, {})), 'edmore-wiki': true })
          })
          if (typeof wiki?.ensure === 'function') await wiki.ensure(input.username)
        }
        else if (input.action === 'reset-password') { validatePassword(input.password); await accounts.change(store => store.setPassword(input.username, input.password)); await revokeUser(input.username) }
        else if (input.action === 'set-disabled') {
          if (typeof input.disabled !== 'boolean') throw fail(400, 'disabled must be boolean')
          await accounts.change(async store => {
            const all = await store.list(); const target = all.find(u => u.username === input.username)
            if (input.disabled && target?.isAdmin && all.filter(u => u.isAdmin && !u.disabled).length <= 1) throw fail(400, 'Cannot disable the last administrator')
            await store.setDisabled(input.username, input.disabled)
          })
          if (input.disabled) await revokeUser(input.username)
        } else throw fail(400, 'Unknown account action')
        json(res, 200, { ok: true }); return
      }
    }
    const allowed = ['/edmore', '/edmore/', '/edmore/index.html', '/edmore/app.js', '/edmore/style.css', '/edmore/extensions.js'].includes(url.pathname) || /^\/api\/(edmore|edmore-workspace|edmore-session-state)(\/|$)/.test(url.pathname)
    if (!allowed) throw fail(404, 'Not found')
    // Do not expose generic event injection, hardware actions, or arbitrary
    // provider URLs/credential references through an authenticated worker.
    if (req.method !== 'GET' && req.method !== 'HEAD' && ![
      '/api/edmore/actions/trigger', '/api/edmore/actions/cancel', '/api/edmore/actions/cancel-workflow', '/api/edmore/actions/approve', '/api/edmore/actions/reject', '/api/edmore/actions/resume', '/api/edmore/actions/cancel-paused',
      '/api/edmore/conversation-model', '/api/edmore/agent-roles', '/api/edmore/llm/providers', '/api/edmore/llm/active',
      '/api/edmore-workspace/projects', '/api/edmore-workspace/conversations', '/api/edmore-workspace/conversations/touch',
    ].includes(url.pathname) && !/^\/api\/edmore\/extensions\/[a-z][a-z0-9-]*\/state$/.test(url.pathname)) throw fail(403, 'Operation unavailable')
    let payload = req.method === 'POST' ? await body(req) : undefined
    if (url.pathname === '/api/edmore/llm/providers') {
      if (req.method === 'DELETE' && url.searchParams.get('id') !== 'openai') throw fail(403, 'Shared models are managed by the administrator')
      if (payload) {
        if (payload.id !== 'openai') throw fail(403, 'Shared models are managed by the administrator')
        payload = { id: 'openai', displayName: 'OpenAI', model: payload.model, apiKey: payload.apiKey || payload.api_key, apiKeyEnv: 'OPENAI_API_KEY', api: 'openai-completions', baseURL: 'https://api.openai.com/v1' }
      }
    }
    if (payload?.cwd !== undefined) {
      const directory = await realpath(payload.cwd).catch(() => { throw fail(400, 'Project directory does not exist') })
      const own = await realpath(workers.paths(user.username).workspace)
      if (directory !== own && !directory.startsWith(own + sep)) throw fail(403, 'Project must be inside your workspace')
    }
    const entry = await workers.get(user.username)
    if (payload && (payload.provider === 'openai' || (url.pathname === '/api/edmore/llm/active' && payload.id === 'openai'))) {
      const profiles = await fetch(`http://127.0.0.1:${entry.port}/api/edmore/llm/providers`, { headers: { 'x-edmore-worker-token': entry.token }, signal: AbortSignal.timeout(5000) }).then(r => r.json())
      if (!profiles.profiles.find(p => p.id === 'openai')?.credential?.configured) throw fail(400, 'Configure your own OpenAI API key first')
    }
    entry.requests++
    if (!['GET', 'HEAD'].includes(req.method)) entry.mutations = (entry.mutations || 0) + 1
    try {
      await relay(req, res, `http://127.0.0.1:${entry.port}${url.pathname}${url.search}`, { 'x-edmore-worker-token': entry.token }, payload === undefined ? undefined : JSON.stringify(payload))
    } finally { entry.requests--; if (!['GET', 'HEAD'].includes(req.method)) entry.mutations--; entry.used = Date.now() }
  }
  const httpHandler = (req, res) => { void handler(req, res).catch(error => {
    if (!res.headersSent && !res.destroyed) json(res, error.status || 400, { error: error.message })
    else res.destroy()
  }) }
  const certPath = options.certPath || process.env.EDMORE_TLS_CERT_FILE
  const keyPath = options.keyPath || process.env.EDMORE_TLS_KEY_FILE
  if (Boolean(certPath) !== Boolean(keyPath) || (origin?.startsWith('https:') && !certPath)) {
    await workers.close(); modelServer.close(); throw new Error('HTTPS requires both certificate and key files')
  }
  const server = certPath ? createHttpsServer({ cert: await readFile(certPath), key: await readFile(keyPath) }, httpHandler) : createServer(httpHandler)
  server.on('upgrade', (_req, socket) => socket.destroy())
  try { await new Promise((ok, reject) => { server.once('error', reject); server.listen(port, host, ok) }) }
  catch (error) { await workers.close(); modelServer.close(); throw error }
  origin ||= `http://127.0.0.1:${server.address().port}`
  const sweep = setInterval(() => { for (const token of sockets.keys()) if (!sessions.verify(token)) disconnect(token) }, 5000)
  sweep.unref()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true; clearInterval(sweep)
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal)
    server.closeAllConnections(); modelServer.closeAllConnections()
    await Promise.all([new Promise(ok => server.close(ok)), new Promise(ok => modelServer.close(ok)), workers.close()])
  }
  const onSignal = () => { void close().then(() => process.exit(0)) }
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal)
  console.log(`EDMORE login enabled: ${origin}/login`)
  return { server, close, workers, accounts, sessions, origin, adminSettings }
}
