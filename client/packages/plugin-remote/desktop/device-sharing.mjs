import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { networkInterfaces } from 'node:os'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const protocolHeaders = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
export function localDeviceRows(rows) {
  const selected = [], skipped = []
  for (const row of rows) {
    let url
    try { url = new URL(row.url) } catch { /* Non-HTTP transports have no URL. */ }
    if (row.transport !== 'streamable-http' || !url || !loopback.has(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
      skipped.push(row.id); continue
    }
    selected.push(row)
  }
  return { selected, skipped }
}

export class DeviceSharing {
  constructor() { this.rows = []; this.sockets = new Set() }
  get state() { return { enabled: Boolean(this.server), registered: this.rows.map(row => row.id), skipped: this.skipped ?? [] } }
  async start(connection, rows, interfaces = networkInterfaces()) {
    if (this.server) return this.state
    const user = await connection.json('/auth/me')
    const address = user.deviceAddress
    if (!address || !Object.values(interfaces).flat().some(row => !row.internal && row.address === address)) throw new Error('No directly reachable VPN interface. Connect the VPN and retry.')
    const { selected, skipped } = localDeviceRows(rows)
    this.skipped = skipped
    if (!selected.length) throw new Error('No enabled local HTTP MCP connections. stdio connections cannot be shared by this bridge.')
    const existing = await connection.json('/auth/mcp')
    const conflicts = selected.filter(row => [...existing.rows, ...existing.shared].some(old => old.id === row.id))
    if (conflicts.length) throw new Error(`Cloud MCP names already exist: ${conflicts.map(row => row.id).join(', ')}. No connections were overwritten.`)
    const token = randomBytes(32).toString('hex')
    const expected = Buffer.from(`Bearer ${token}`)
    const routes = new Map(selected.map(row => [`/mcp/${row.id}`, row]))
    const server = createServer((req, res) => {
      const supplied = Buffer.from(req.headers.authorization || '')
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401); res.end(); return }
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) { res.writeHead(405); res.end(); return }
      const row = routes.get(req.url) ?? selected.find(item => item.kind === 'edmore' && new RegExp(`^/mcp/${item.id}/(agents|mcp/[^/]+/)$`).test(req.url))
      if (!row) { res.writeHead(404); res.end(); return }
      const suffix = row.kind === 'edmore' ? req.url.slice(`/mcp/${row.id}`.length) : ''
      const url = new URL(row.kind === 'edmore' ? row.url.replace(/\/$/, '') + suffix : row.url)
      // Fixed local destinations only; never forward cloud cookies, auth, Origin,
      // redirects or arbitrary URL paths to a local HTTP service.
      if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
      const headers = {}
      for (const key of protocolHeaders) if (req.headers[key]) headers[key] = req.headers[key]
      for (const [key, value] of Object.entries(row.headers ?? {})) {
        if (!['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'cookie', 'proxy-authorization'].includes(key.toLowerCase())) headers[key] = value
      }
      const upstream = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: req.method, headers, agent: false }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); res.writeHead(502); res.end('MCP redirects are not allowed'); return }
        const outgoing = { 'cache-control': 'no-store' }
        for (const key of protocolHeaders) if (response.headers[key]) outgoing[key] = response.headers[key]
        res.writeHead(response.statusCode || 502, outgoing); response.pipe(res)
        response.on('error', () => res.destroy())
      })
      upstream.setTimeout(60000, () => upstream.destroy(new Error('MCP timeout')))
      upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('Local MCP unavailable') } else res.destroy() })
      res.on('close', () => upstream.destroy())
      req.pipe(upstream)
    })
    server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)) })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, address, resolve) })
    this.server = server; this.connection = connection; this.username = user.username
    try {
      for (const row of selected) {
        const registered = { id: row.id, kind: row.kind, transport: 'streamable-http', enabled: true,
          url: `http://${address}:${server.address().port}/mcp/${row.id}`, secrets: { Authorization: `Bearer ${token}` } }
        await connection.json('/auth/mcp', registered)
        this.rows.push({ id: row.id, url: registered.url })
      }
    } catch (error) {
      await this.stop().catch(() => this.close())
      throw error
    }
    return this.state
  }
  async stop() {
    if (!this.server) return this.state
    const user = await this.connection.json('/auth/me')
    if (user.username !== this.username) { await this.close(); throw new Error('Cloud account changed. Previous device connections remain offline in the old account.') }
    const current = await this.connection.json('/auth/mcp')
    for (const row of [...this.rows]) {
      // Do not remove a connection that was changed in the cloud meanwhile.
      if (current.rows.some(item => item.id === row.id && item.url === row.url)) await this.connection.json('/auth/mcp', { id: row.id, remove: true })
      this.rows = this.rows.filter(item => item.id !== row.id)
    }
    await this.close()
    return this.state
  }
  async close() {
    const server = this.server
    this.server = undefined; this.rows = []
    for (const socket of this.sockets) socket.destroy()
    if (server) await new Promise(resolve => server.close(resolve))
  }
}
