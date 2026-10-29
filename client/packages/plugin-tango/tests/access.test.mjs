import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { assertion, identity, endpoint, TangoAccess } from '../src/access.mjs'
import { tangoConnection } from '../src/index.mjs'
import { prepareAccess } from '../src/configure.mjs'

const alice = { username: 'alice', createdAt: 123, isAdmin: false }
const bob = { username: 'bob', createdAt: 456, isAdmin: false }
const config = { version: 1, issuer: 'harness', signingSecret: 'test-only-key-'.repeat(4) }

test('configuration bootstrap generates private matched keys and refuses overwrite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tango-setup-')); t.after(() => rm(root, { recursive: true, force: true }))
  const options = { directory: join(root, 'access'), issuer: 'local', registrationUrl: 'http://127.0.0.1:8780', mcpUrl: 'http://127.0.0.1:8767/mcp', registrationState: join(root, 'state.json') }
  const files = await prepareAccess(options)
  const harness = JSON.parse(await readFile(files.harnessFile, 'utf8')), gateway = JSON.parse(await readFile(files.gatewayFile, 'utf8'))
  assert.equal(harness.signingSecret, gateway.issuers.local.secret)
  assert.equal((await stat(files.harnessFile)).mode & 0o777, 0o600)
  assert.equal((await stat(options.directory)).mode & 0o777, 0o700)
  await assert.rejects(prepareAccess(options), { code: 'EEXIST' })
})

test('stable identities, signed audience, account replacement and disabled accounts', () => {
  assert.equal(identity(config, alice), identity(config, { ...alice, salt: 'changed' }))
  assert.notEqual(identity(config, alice), identity(config, { ...alice, createdAt: 124 }))
  assert.throws(() => identity(config, { ...alice, disabled: true }), /Active/)
  const [payload, sig] = assertion(config, alice, 'tango-mcp', 123456).split('.')
  const claims = JSON.parse(Buffer.from(payload, 'base64url'))
  assert.equal(claims.aud, 'tango-mcp'); assert.equal(claims.exp, 123516); assert.equal(claims.admin, false)
  assert.equal(sig, createHmac('sha256', config.signingSecret).update(payload).digest('base64url'))
})

test('workers cannot fall back to shared raw gateway credentials', () => {
  assert.equal(tangoConnection({ EDMORE_AUTH_WORKER: '1', EDMORE_TANGO_MCP_URL: 'https://gateway/mcp', EDMORE_TANGO_MCP_TOKEN: 'shared' }), undefined)
  assert.throws(() => tangoConnection({ EDMORE_AUTH_WORKER: '1', EDMORE_TANGO_PROXY_URL: 'http://example.com/tango/mcp', EDMORE_WORKER_TOKEN: 'worker' }))
  assert.equal(tangoConnection({ EDMORE_AUTH_WORKER: '1', EDMORE_TANGO_PROXY_URL: 'http://127.0.0.1:8760/tango/mcp', EDMORE_WORKER_TOKEN: 'worker' }).headers.Authorization, 'Bearer worker')
  for (const url of ['http://example.com/mcp', 'https://user:pass@example.com', 'https://example.com/?secret=x']) assert.throws(() => endpoint(url))
})

test('registration resolves trusted target and proxy strips identity/session/secret headers', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tango-access-')); t.after(() => rm(home, { recursive: true, force: true }))
  const seen = []
  const backend = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part
    seen.push({ headers: req.headers, body, url: req.url })
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}')
  })
  await new Promise(ok => backend.listen(0, '127.0.0.1', ok)); t.after(() => new Promise(ok => backend.close(ok)))
  const origin = `http://127.0.0.1:${backend.address().port}`
  const file = join(home, 'access.json')
  await writeFile(file, JSON.stringify({ ...config, registrationUrl: origin, mcpUrl: origin + '/mcp' }))
  const access = new TangoAccess(file)
  await access.devices(alice, { action: 'share', device: 'edmore/tem/alice', username: 'bob', target: 'forged', permission: 'read' }, async () => [alice, bob])
  assert.equal(JSON.parse(seen[0].body).target, `harness:${identity(config, bob)}`)
  await assert.rejects(access.devices(alice, { action: 'assign', username: 'bob' }, async () => [bob]), { status: 403 })
  await assert.rejects(access.devices(alice, { action: 'share', username: 'disabled' }, async () => []), { status: 400 })
  const proxy = createServer((req, res) => access.proxy(req, res, alice).catch(() => { res.writeHead(502); res.end() }))
  await new Promise(ok => proxy.listen(0, '127.0.0.1', ok)); t.after(() => new Promise(ok => proxy.close(ok)))
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}`, { method: 'POST', headers: { authorization: 'Bearer forged', cookie: 'secret', 'x-user': 'admin', 'mcp-session-id': 'stolen', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
  assert.equal(response.status, 200); await response.text()
  const forwarded = seen[1]
  assert.equal(forwarded.headers.cookie, undefined); assert.equal(forwarded.headers['x-user'], undefined); assert.equal(forwarded.headers['mcp-session-id'], undefined)
  const claims = JSON.parse(Buffer.from(forwarded.headers.authorization.slice(7).split('.')[0], 'base64url'))
  assert.equal(claims.sub, identity(config, alice)); assert.equal(claims.admin, false); assert.equal(claims.aud, 'tango-mcp')
})
