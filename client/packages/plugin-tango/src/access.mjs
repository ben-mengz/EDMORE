import { createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'

const fail = (status, message) => Object.assign(new Error(message), { status })

export function identity(config, user) {
  if (!user || user.disabled || !user.username || !user.createdAt) throw fail(403, 'Active Harness account required')
  return createHash('sha256').update(`${config.issuer}\0${user.username}\0${user.createdAt}`).digest('hex')
}

export function assertion(config, user, audience, now = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({ v: 1, iss: config.issuer, sub: identity(config, user),
    label: user.username, admin: user.isAdmin === true, aud: audience, iat: now, exp: now + 60 })).toString('base64url')
  return payload + '.' + createHmac('sha256', config.signingSecret).update(payload).digest('base64url')
}

export function endpoint(value) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new Error('Tango endpoints require HTTPS or explicit loopback HTTP')
  }
  return url
}

export class TangoAccess {
  constructor(configuration) { this.configuration = configuration }

  async config() {
    const config = JSON.parse(await readFile(this.configuration, 'utf8'))
    if (config.version !== 1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(config.issuer) ||
        typeof config.signingSecret !== 'string' || config.signingSecret.length < 32) throw new Error('Invalid Tango identity configuration')
    endpoint(config.registrationUrl); endpoint(config.mcpUrl)
    return config
  }

  async request(config, url, headers, method, payload) {
    const target = endpoint(url)
    const ca = config.caFile ? await readFile(config.caFile) : undefined
    return new Promise((resolve, reject) => {
      const req = (target.protocol === 'https:' ? https : http).request(target, { method, headers, ca }, resolve)
      req.once('error', reject)
      req.setTimeout(360_000, () => req.destroy(new Error('Tango request timed out; execution outcome may be unknown')))
      if (payload?.pipe) {
        payload.once('aborted', () => req.destroy())
        payload.pipe(req)
      } else req.end(payload)
    })
  }

  async devices(user, input, users) {
    const config = await this.config()
    let payload
    if (input) {
      const allowed = ['claim', 'activate', 'share', 'approve-share', 'revoke-share', 'block', 'unblock', 'assign']
      if (!allowed.includes(input.action)) throw fail(400, 'Invalid device action')
      if (['assign', 'approve-share'].includes(input.action) && !user.isAdmin) throw fail(403, 'Administrator required')
      const data = { action: input.action, device: input.device, code: input.code, permission: input.permission, request: input.request }
      if (['share', 'revoke-share', 'assign'].includes(input.action)) {
        const target = (await users()).find(row => row.username === input.username && (!row.disabled || input.action === 'revoke-share'))
        if (!target) throw fail(400, 'Active target account required')
        data.target = `${config.issuer}:${identity(config, { ...target, disabled: false })}`
        data.target_label = target.username
      }
      payload = JSON.stringify(data)
    }
    const response = await this.request(config, config.registrationUrl.replace(/\/$/, '') + '/api/v1/harness/devices', {
      authorization: `Bearer ${assertion(config, user, 'tango-registration')}`, 'content-type': 'application/json',
    }, input ? 'POST' : 'GET', payload)
    let text = ''
    for await (const part of response) { text += part; if (text.length > 2_000_000) { response.destroy(); throw fail(502, 'Device inventory is too large') } }
    if (response.statusCode !== 200) throw fail(response.statusCode < 500 ? response.statusCode : 502, `Device service rejected request (${response.statusCode})`)
    return JSON.parse(text)
  }

  async proxy(req, res, user) {
    const config = await this.config()
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) throw fail(405, 'Unsupported MCP method')
    const headers = { authorization: `Bearer ${assertion(config, user, 'tango-mcp')}` }
    for (const name of ['accept', 'content-type', 'mcp-protocol-version']) if (req.headers[name]) headers[name] = req.headers[name]
    // The gateway is stateless. Never forward cookies, user headers or client session IDs.
    const upstream = await this.request(config, config.mcpUrl, headers, req.method, req)
    res.writeHead(upstream.statusCode, { 'content-type': upstream.headers['content-type'] || 'application/json', 'cache-control': 'no-store' })
    res.once('close', () => upstream.destroy())
    upstream.on('error', () => res.destroy())
    upstream.pipe(res)
  }

  async route({ req, res, url, user, users, body, json, refreshTools }) {
    const assets = { '/devices': ['devices.html', 'text/html'], '/auth/tango/devices.js': ['devices.js', 'text/javascript'], '/auth/tango/devices.css': ['devices.css', 'text/css'] }
    if (assets[url.pathname] && req.method === 'GET') {
      const [file, type] = assets[url.pathname]
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'" })
      res.end(await readFile(new URL(`../static/${file}`, import.meta.url))); return true
    }
    if (url.pathname === '/auth/tango/refresh' && req.method === 'POST') {
      if (!refreshTools) throw fail(503, 'Runtime refresh unavailable')
      json(res, 200, await refreshTools()); return true
    }
    if (url.pathname !== '/auth/tango/devices') return false
    if (!['GET', 'POST'].includes(req.method)) throw fail(405, 'Unsupported device method')
    json(res, 200, await this.devices(user, req.method === 'POST' ? await body(req) : undefined, users))
    return true
  }
}
