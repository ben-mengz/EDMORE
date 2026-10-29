import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { wikiRoute } from './wiki-browser.mjs'

function equal(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '')
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function startLocalWikiPortal({ wiki, username, home }) {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username)) throw new Error('A local Wiki owner is required')
  const key = randomBytes(32).toString('hex')
  let ticket, expires = 0, origin
  const sessionExpires = Date.now() + 12 * 3600_000
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
  const fail = (status, message) => Object.assign(new Error(message), { status })
  const relay = (req, res, target, headers) => new Promise(resolve => {
    const url = new URL(target)
    const upstream = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: req.method, headers: { ...headers, 'content-type': req.headers['content-type'] || 'application/json' },
    }, response => {
      res.writeHead(response.statusCode || 502, { 'content-type': response.headers['content-type'] || 'application/json', 'cache-control': 'no-store' })
      response.on('error', () => res.destroy()); response.pipe(res)
    })
    upstream.setTimeout(60000, () => upstream.destroy())
    upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'Wiki unavailable' }); else res.destroy() })
    res.once('close', () => { upstream.destroy(); resolve() })
    req.pipe(upstream)
  })
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
    try {
      if (req.headers.host !== new URL(origin).host) throw fail(403, 'Invalid local host')
      const url = new URL(req.url, origin)
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) throw fail(403, 'Cross-origin request rejected')
      if (url.pathname === '/entry' && req.method === 'GET') {
        if (!ticket || Date.now() > expires || !equal(url.searchParams.get('ticket'), ticket)) throw fail(403, 'Entry expired')
        ticket = undefined
        res.writeHead(303, { location: '/auth/wiki/open', 'set-cookie': `edmore_local_wiki=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` })
        res.end(); return
      }
      const cookie = /(?:^|;\s*)edmore_local_wiki=([^;]+)/.exec(req.headers.cookie || '')?.[1]
      if (Date.now() > sessionExpires || !equal(cookie, key)) throw fail(401, 'Open Wiki from EDMORE')
      if (await wikiRoute({ req, res, url, wiki, user: { username }, home,
        workers: { plugins: async () => [{ id: 'edmore-wiki', enabled: true }] }, relay, json, fail })) return
      throw fail(404, 'Not found')
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 502, { error: error.status ? error.message : 'Wiki request failed' })
      else res.destroy()
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  return { origin, entry() { ticket = randomBytes(32).toString('hex'); expires = Date.now() + 60_000; return `${origin}/entry?ticket=${ticket}` },
    close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) } }
}
