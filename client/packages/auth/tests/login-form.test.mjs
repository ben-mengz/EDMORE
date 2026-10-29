import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Accounts } from '../src/store.mjs'
import { startAuthGateway } from '../src/index.mjs'

test('native POST login works without JavaScript and retains authentication checks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-login-form-'))
  const password = 'test + & = % password-123'
  const accounts = new Accounts(join(home, 'auth/accounts.json'))
  await accounts.change(store => store.create('alice', password, false))
  let gateway
  try {
    gateway = await startAuthGateway({ home, workspace: join(home, 'workspace'), root: resolve('.'), port: 0, host: '127.0.0.1', shared: [] })
    const html = await fetch(gateway.origin + '/login').then(r => r.text())
    assert.match(html, /<form\b[^>]*id="login"[^>]*method="post"[^>]*action="\/auth\/login"/)
    const submit = (payload, { origin = gateway.origin, cookie = '', json = false } = {}) => fetch(gateway.origin + '/auth/login', {
      method: 'POST', redirect: 'manual',
      headers: { origin, cookie, 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: json ? JSON.stringify(payload) : new URLSearchParams(payload).toString(),
    })
    const payload = { username: 'alice', password }
    const response = await submit(payload)
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), '/edmore/')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(response.headers.get('set-cookie'), /HttpOnly/)
    const cookie = response.headers.get('set-cookie').split(';')[0]
    const identity = await fetch(gateway.origin + '/auth/me', { headers: { cookie } })
    assert.equal(identity.status, 200)
    assert.equal((await identity.json()).username, 'alice')

    const denied = await submit(payload, { origin: 'https://attacker.invalid' })
    assert.equal(denied.status, 403)
    assert.equal(denied.headers.get('set-cookie'), null)
    const invalid = await submit({ ...payload, password: 'incorrect' })
    assert.equal(invalid.status, 401)
    assert.equal(invalid.headers.get('set-cookie'), null)
    assert.equal((await submit({ username: 'alice' })).status, 400)
    assert.equal((await submit({ ...payload, password: 'x'.repeat(257) })).status, 400)

    const jsonLogin = await submit(payload, { json: true, cookie })
    assert.equal(jsonLogin.status, 200)
    assert.deepEqual(await jsonLogin.json(), { ok: true })
    assert.equal((await fetch(gateway.origin + '/auth/me', { headers: { cookie } })).status, 401)
    const newCookie = jsonLogin.headers.get('set-cookie').split(';')[0]
    assert.equal((await fetch(gateway.origin + '/auth/me', { headers: { cookie: newCookie } })).status, 200)
  } finally {
    if (gateway) await gateway.close()
    await rm(home, { recursive: true, force: true })
  }
})
