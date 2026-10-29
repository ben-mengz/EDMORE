import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Accounts, writeJson } from '../src/store.mjs'
import { startAuthGateway } from '../src/index.mjs'

test('device routes use live Harness identity, protect roles and CSRF, and obey feature disable', async t => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-tango-auth-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const seen = []
  const backend = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    seen.push({ body, claims: JSON.parse(Buffer.from(req.headers.authorization.slice(7).split('.')[0], 'base64url')) })
    res.setHeader('Content-Type', 'application/json'); res.end('{"devices":[],"shares":[],"ok":true}')
  })
  await new Promise(ok => backend.listen(0, '127.0.0.1', ok)); t.after(() => new Promise(ok => backend.close(ok)))
  const url = `http://127.0.0.1:${backend.address().port}`
  const access = join(home, 'access.json'), features = join(home, 'features.json')
  await writeJson(access, { version: 1, issuer: 'test', signingSecret: 'test-key'.repeat(8), registrationUrl: url, mcpUrl: url + '/mcp' })
  await writeJson(features, { version: 1, disabled: [] })
  const previous = { access: process.env.EDMORE_TANGO_ACCESS_FILE, features: process.env.EDMORE_FEATURE_CONFIG }
  process.env.EDMORE_TANGO_ACCESS_FILE = access; process.env.EDMORE_FEATURE_CONFIG = features
  t.after(() => { for (const [key, value] of [['EDMORE_TANGO_ACCESS_FILE', previous.access], ['EDMORE_FEATURE_CONFIG', previous.features]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  } })
  const accounts = new Accounts(join(home, 'auth/accounts.json'))
  for (const username of ['admin', 'alice', 'bob']) await accounts.change(s => s.create(username, 'long-test-password', username === 'admin'))
  const gateway = await startAuthGateway({ home, workspace: join(home, 'workspaces'), root: resolve('.'), port: 0, host: '127.0.0.1', shared: [] })
  t.after(() => gateway.close())
  const call = (path, cookie, input, origin = gateway.origin) => fetch(gateway.origin + path, { redirect: 'manual', method: input ? 'POST' : 'GET', headers: { cookie: cookie || '', origin, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) })
  const login = async username => (await call('/auth/login', null, { username, password: 'long-test-password' })).headers.get('set-cookie').split(';')[0]
  const alice = await login('alice'), admin = await login('admin')
  assert.equal((await call('/devices')).status, 302)
  assert.equal((await call('/auth/tango/devices')).status, 401)
  assert.equal((await call('/devices', alice)).status, 200)
  const me = await (await call('/auth/me', alice)).json(); assert.equal(me.devices.available, true)
  assert.equal((await call('/auth/tango/devices', alice)).status, 200)
  assert.equal(seen.at(-1).claims.label, 'alice'); assert.equal(seen.at(-1).claims.admin, false)
  assert.equal((await call('/auth/tango/devices', alice, { action: 'approve-share' })).status, 403)
  assert.equal((await call('/auth/tango/devices', alice, { action: 'claim', code: 'code' }, 'https://evil.invalid')).status, 403)
  assert.equal((await call('/auth/tango/devices', admin, { action: 'assign', device: 'edmore/tem/test', username: 'alice' })).status, 200)
  assert.equal(seen.at(-1).claims.admin, true)
  assert.equal((await call('/auth/tango/refresh', alice, {})).status, 200)
  const worker = { username: 'alice', token: 'test-worker-only', used: Date.now(), requests: 0, child: null }
  gateway.workers.entries.set('alice', worker)
  const proxy = () => fetch(gateway.workers.modelUrl + '/tango/mcp', { method: 'POST', headers: { authorization: 'Bearer '+worker.token, 'x-user': 'admin' }, body: '{}' })
  const proxied = await proxy(); assert.equal(proxied.status, 200); await proxied.text()
  assert.equal(seen.at(-1).claims.label, 'alice'); assert.equal(seen.at(-1).claims.admin, false)
  await accounts.change(s => s.setDisabled('alice', true))
  assert.equal((await proxy()).status, 403)
  gateway.workers.entries.delete('alice')
  assert.equal((await call('/auth/tango/devices', alice)).status, 401)
  await writeJson(features, { version: 1, disabled: ['tango'] })
  assert.equal((await call('/auth/tango/devices', admin)).status, 503)
})
