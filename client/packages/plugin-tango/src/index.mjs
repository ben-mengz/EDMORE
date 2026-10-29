export function tangoConnection(env = process.env) {
  const serverName = env.EDMORE_TANGO_SERVER_NAME || 'tango'
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(serverName)) throw new Error('Invalid Tango server name')
  if (env.EDMORE_AUTH_WORKER === '1') {
    if (!env.EDMORE_TANGO_PROXY_URL || !env.EDMORE_WORKER_TOKEN) return undefined
    const proxy = new URL(env.EDMORE_TANGO_PROXY_URL)
    if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || proxy.pathname !== '/tango/mcp' || proxy.username || proxy.password || proxy.hash || proxy.search) throw new Error('Invalid Harness Tango proxy')
    return { serverName, transport: 'streamable-http', url: proxy.href, headers: { Authorization: `Bearer ${env.EDMORE_WORKER_TOKEN}` } }
  }
  if (!env.EDMORE_TANGO_MCP_URL) return undefined
  const url = new URL(env.EDMORE_TANGO_MCP_URL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('Invalid Tango MCP endpoint')
  return { serverName, transport: 'streamable-http', url: url.href,
    ...(env.EDMORE_TANGO_MCP_TOKEN ? { headers: { Authorization: `Bearer ${env.EDMORE_TANGO_MCP_TOKEN}` } } : {}) }
}
