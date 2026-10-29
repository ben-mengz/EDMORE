import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const blocked = new BlockList()
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address, prefix)
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [['2001::',32],['2001:db8::',32],['2002::',16]]) blocked.addSubnet(address, prefix, 'ipv6')
export function publicAddress(address) {
  const family = isIP(address)
  return family === 4 ? !blocked.check(address) : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}
export async function publicTarget(url, resolve = lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname, { all: true })
  if (!addresses.length || addresses.some(row => !publicAddress(row.address))) throw Object.assign(new Error('Personal MCP requires a public endpoint; ask the administrator to configure private-network connections'), { status: 400 })
  return addresses[0]
}

const deviceNetworks = new BlockList()
for (const [address, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]]) deviceNetworks.addSubnet(address, prefix)
export function deviceAddress(peer) {
  const address = typeof peer === 'string' ? peer.replace(/^::ffff:/, '') : ''
  return isIP(address) === 4 && deviceNetworks.check(address) ? address : undefined
}
export function deviceTarget(url, peer) {
  const address = deviceAddress(peer)
  if (!address || url.hostname !== address) throw Object.assign(new Error('Device MCP must use your current VPN IP, not localhost or another private host'), { status: 400 })
  return { address, family: 4 }
}

export async function personalTarget(url, peer) {
  if (deviceAddress(peer) && url.hostname === deviceAddress(peer)) return deviceTarget(url, peer)
  return publicTarget(url)
}

// Resolve and pin each outbound connection. Never follow redirects or forward
// the worker's authorization token, cookies, or arbitrary incoming headers.
export async function relayPersonalMcp(req, res, row, suffix, resolveTarget = publicTarget) {
  if (!['POST', 'GET', 'DELETE'].includes(req.method)) throw new Error('Unsupported MCP method')
  if (row.kind === 'edmore' ? !/^\/(agents|mcp\/[^/]+\/)$/u.test(suffix) : suffix !== '') throw new Error('Invalid MCP path')
  const url = new URL(row.kind === 'edmore' ? row.url.replace(/\/$/, '') + suffix : row.url)
  const address = row.deviceAddress ? deviceTarget(url, row.deviceAddress) : await resolveTarget(url)
  const headers = {}
  for (const [key, value] of Object.entries(row.headers || {})) {
    if (!['host','connection','content-length','transfer-encoding','upgrade','proxy-authorization'].includes(key.toLowerCase())) headers[key.toLowerCase()] = value
  }
  for (const key of ['content-type','accept','mcp-session-id','mcp-protocol-version','last-event-id']) if (req.headers[key]) headers[key] = req.headers[key]
  await new Promise(resolve => {
    const upstream = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: req.method, headers, agent: false,
      lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); res.writeHead(502); res.end('MCP redirects are not allowed'); return }
      const outgoing = { 'cache-control': 'no-store' }
      for (const key of ['content-type','mcp-session-id','mcp-protocol-version']) if (response.headers[key]) outgoing[key] = response.headers[key]
      res.writeHead(response.statusCode || 502, outgoing); response.pipe(res)
      response.on('error', () => res.destroy())
    })
    upstream.setTimeout(60_000, () => upstream.destroy(new Error('MCP timeout')))
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('MCP unavailable') } else res.destroy() })
    res.once('close', () => { upstream.destroy(); resolve() })
    req.pipe(upstream)
  })
}
