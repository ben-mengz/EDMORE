import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Accounts, writeJson, pluginCatalog } from '../src/store.mjs'
import { ModelQueue } from '../src/queue.mjs'
import { startAuthGateway } from '../src/index.mjs'
import { AdminSettings } from '../src/admin.mjs'

test('accounts serialize concurrent creation and reject corrupt storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'edmore-accounts-'))
  try {
    const accounts = new Accounts(join(dir, 'accounts.json'))
    await accounts.change(s => s.create('admin', 'long-test-password', true))
    await Promise.all(['alice', 'bob'].map(name => accounts.change(s => s.create(name, 'long-test-password', false))))
    assert.equal((await accounts.users.list()).length, 3)
    assert.ok(await accounts.users.verify('alice', 'long-test-password'))
    assert.equal(await accounts.users.verify('alice', 'incorrect'), undefined)
    assert.ok(!(await readFile(accounts.path, 'utf8')).includes('long-test-password'))
    await accounts.change(s => s.setDisabled('alice', true))
    assert.equal(await accounts.users.verify('alice', 'long-test-password'), undefined)
    await writeJson(accounts.path, { invalid: true })
    await assert.rejects(accounts.users.list(), /Invalid account store/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Wiki is enabled by default for every account', () => {
  assert.equal(pluginCatalog.find(plugin => plugin.id === 'edmore-wiki')?.defaultEnabled, true)
})

test('shared queue serializes generation, bounds users and removes cancelled requests', async () => {
  const queue = new ModelQueue(1)
  const first = await queue.acquire('alice', new AbortController().signal)
  const cancelled = new AbortController()
  const second = queue.acquire('bob', cancelled.signal)
  cancelled.abort(); await assert.rejects(second)
  let started = false
  const third = queue.acquire('carol', new AbortController().signal).then(release => { started = true; return release })
  await Promise.resolve(); assert.equal(started, false)
  first(); const release = await third; assert.equal(started, true); release()
  assert.equal(queue.active, 0); assert.equal(queue.waiting.length, 0)
  const limited = new ModelQueue(1, 1)
  const occupied = await limited.acquire('alice', new AbortController().signal)
  const waiting = limited.acquire('alice', new AbortController().signal)
  await assert.rejects(limited.acquire('alice', new AbortController().signal), { status: 429 })
  await assert.rejects(limited.acquire('bob', new AbortController().signal), { status: 429 })
  occupied(); (await waiting)()
  assert.equal(limited.active, 0)
})

test('two real Harness workers isolate API data, credentials, plugins and sessions', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'edmore-multiuser-'))
  const accounts = new Accounts(join(home, 'auth/accounts.json'))
  for (const username of ['admin', 'alice', 'bob']) await accounts.change(s => s.create(username, 'long-test-password', username === 'admin'))
  let gateway
  try {
    gateway = await startAuthGateway({ home, workspace: join(home, 'workspaces'), root: resolve('.'), port: 0, host: '127.0.0.1', shared: [
      { id: 'llm3-hu', displayName: 'HU LLM', model: 'llm3', baseURL: 'http://127.0.0.1:1/v1', key: 'shared-hu-secret' },
      { id: 'bonsai-local', displayName: 'Bonsai', model: 'bonsai-2-27b', baseURL: 'http://127.0.0.1:1/v1', contextWindow: 131072, key: 'shared-bonsai-secret' },
    ] })
    const call = (path, cookie, payload, method) => fetch(gateway.origin + path, { redirect: 'manual', method: method || (payload ? 'POST' : 'GET'), headers: { origin: gateway.origin, ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) })
    assert.equal((await call('/edmore/')).status, 302)
    assert.equal((await call('/api/edmore/state')).status, 401)
    const login = async name => { const response = await call('/auth/login', null, { username: name, password: 'long-test-password' }); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0] }
    const [alice, bob, admin] = await Promise.all(['alice', 'bob', 'admin'].map(login))
    assert.equal((await call('/auth/users', admin, { action: 'create', username: 'newuser', password: 'long-test-password' })).status, 200)
    assert.equal(JSON.parse(await readFile(join(home, 'auth/users/newuser/plugins.json'), 'utf8'))['edmore-wiki'], true)
    await assert.rejects(readFile(join(home, 'auth/users/bob/plugins.json'), 'utf8'), { code: 'ENOENT' })
    assert.equal((await call('/auth/mcp')).status, 401)
    assert.equal((await call('/auth/mcp-editor.js', alice)).status, 200)
    assert.equal((await call('/auth/mcp', alice, { id: 'personal', kind: 'standard', url: 'https://8.8.8.8/mcp', enabled: false, secrets: { Authorization: 'alice-mcp-secret' } })).status, 200)
    assert.equal((await call('/auth/mcp', alice).then(r => r.json())).rows.length, 1)
    assert.equal((await call('/auth/mcp', bob).then(r => r.json())).rows.length, 0)
    assert.ok(!(await call('/auth/mcp', alice).then(r => r.text())).includes('alice-mcp-secret'))
    assert.equal((await call('/auth/mcp', alice, { id: 'local', url: 'http://127.0.0.1/mcp', enabled: true })).status, 400)
    assert.equal((await call('/auth/mcp', alice, { id: 'exec', transport: 'stdio', command: 'sh', args: [], enabled: true })).status, 400)
    for (const path of ['/admin', '/admin/app.js', '/admin/style.css', '/api/admin/settings', '/api/admin/skills']) {
      assert.equal((await call(path, alice)).status, 403)
      assert.equal((await call(path, admin)).status, 200)
    }
    for (const path of ['plugins','mcp','skills','workers/restart','apply']) assert.equal((await call(`/api/admin/${path}`, bob, {})).status, 403)
    assert.equal((await call('/api/admin/plugins', admin, {id:'edmore-jev-decisions',enabled:true})).status, 400)
    assert.equal((await call('/api/admin/skills', admin, {category:'support',id:'online-test',name:'Online test',description:'A shared test skill',content:'Return a concise answer.'})).status, 200)
    const [a, b] = await Promise.all([call('/api/edmore-workspace/projects', alice), call('/api/edmore-workspace/projects', bob)])
    if (a.status !== 200 || b.status !== 200) {
      console.error('workers', await a.clone().text(), await b.clone().text())
      for (const name of ['alice', 'bob']) console.error(name, await readFile(join(home, 'auth/users', name, 'worker.log'), 'utf8').catch(() => 'no log'))
    }
    assert.equal(a.status, 200); assert.equal(b.status, 200)
    for (let retry = 0; retry < 2; retry++) {
      const cancelled = await call('/api/edmore/actions/cancel-workflow', alice, { session_id: 'cancel-priority-test', action_id: 'stale' })
      assert.equal(cancelled.status, 200)
      assert.equal((await cancelled.json()).ok, true)
    }
    assert.equal((await call('/api/edmore/actions/cancel-workflow', null, { session_id: 'cancel-priority-test' })).status, 401)
    const projectA = (await a.json()).projects[0]
    const projectB = (await b.json()).projects[0]
    assert.notEqual(projectA.cwd, projectB.cwd)
    const alicePatch = JSON.parse(await readFile(join(home,'auth/users/alice/admin.patch.json'),'utf8'))
    assert.equal(alicePatch.find(p=>p.id==='edmore-jev-decisions').disabled,true)
    const skillDirectory = alicePatch.find(p=>p.id==='skill-filesystem').config.customSkillDirs[1]
    assert.match(await readFile(join(skillDirectory,'online-test/SKILL.md'),'utf8'),/Return a concise answer/)
    assert.equal((await call('/api/admin/mcp',admin,{id:'private',transport:'streamable-http',url:'https://example.invalid/mcp',enabled:false,secrets:{Authorization:'Bearer test-secret'}})).status,200)
    const publicSettings = await call('/api/admin/settings',admin).then(r=>r.text())
    assert.ok(!publicSettings.includes('test-secret'))
    assert.ok(publicSettings.includes('secretConfigured'))
    const conversation = await call('/api/edmore-workspace/conversations', alice, { project_id: projectA.id, title: 'Alice private conversation' }).then(r => r.json())
    assert.ok(conversation.conversation)
    const bList = await call('/api/edmore-workspace/conversations', bob).then(r => r.text())
    assert.ok(!bList.includes('Alice private conversation'))
    assert.equal((await call('/api/edmore/llm/providers', alice, { id: 'bonsai-local', model: 'evil', apiKey: 'changed' })).status, 403)
    assert.equal((await call('/api/edmore/llm/providers?id=llm3-hu', alice, null, 'DELETE')).status, 403)
    assert.equal((await call('/api/edmore/events', alice, {})).status, 403)
    assert.equal((await call('/auth/users', bob)).status, 403)
    assert.equal((await call('/api/edmore/llm/active', bob, { provider: 'openai' })).status, 400)
    assert.equal((await call('/api/edmore-workspace/projects', alice, { name: 'escape', cwd: home })).status, 403)
    assert.equal((await call('/api/edmore/llm/providers', alice, { id: 'openai', model: 'gpt-5-mini', apiKey: 'alice-private-test-key' })).status, 200)
    const providersA = await call('/api/edmore/llm/providers', alice).then(r => r.json())
    const providersB = await call('/api/edmore/llm/providers', bob).then(r => r.json())
    assert.equal(providersA.profiles.find(p => p.id === 'openai').credential.configured, true)
    assert.equal(providersB.profiles.find(p => p.id === 'openai').credential.configured, false)
    assert.ok(!JSON.stringify(providersA).includes('alice-private-test-key'))
    assert.ok(!(await readFile(join(home, 'auth/users/alice/edmore/.credentials.yaml'), 'utf8')).includes('shared-bonsai-secret'))
    assert.equal((await call('/edmore/extensions.js', alice)).status, 200)
    assert.equal((await call('/api/edmore/extensions/tango/panel.js', alice)).status, 200)
    assert.equal((await call('/auth/plugins', alice, { id: 'edmore-model-hu', enabled: false })).status, 200)
    assert.equal((await call('/api/edmore/llm/providers', alice).then(r => r.json())).profiles.some(p => p.id === 'llm3-hu'), false)
    assert.equal((await call('/api/edmore/llm/providers', bob).then(r => r.json())).profiles.some(p => p.id === 'llm3-hu'), true)
    const disabledModelWorker = await gateway.workers.get('alice')
    assert.equal((await fetch(gateway.workers.modelUrl + '/llm3-hu/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${disabledModelWorker.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llm3', messages: [] }) })).status, 403)
    assert.equal((await call('/auth/plugins', alice, { id: 'edmore-tango', enabled: false })).status, 200)
    assert.deepEqual((await call('/api/edmore/extensions', alice).then(r => r.json())).extensions, [])
    assert.equal((await call('/api/edmore/extensions/tango/panel.js', alice)).status, 404)
    assert.equal((await call('/api/edmore/extensions/tango/state', alice, { session_id: 'test', devices: [] })).status, 404)
    assert.equal((await call('/edmore/', alice)).status, 200)
    const worker = await gateway.workers.get('alice')
    assert.equal((await fetch(`http://127.0.0.1:${worker.port}/api/edmore/state`)).status, 401)
    const crossOrigin = await fetch(gateway.origin + '/auth/logout', { method: 'POST', headers: { cookie: alice, origin: 'https://attacker.invalid' } })
    assert.equal(crossOrigin.status, 403)
    assert.equal((await call('/auth/plugins', alice, { id: 'edmore-conversation-title', enabled: false })).status, 200)
    assert.equal((await call('/auth/me', alice).then(r => r.json())).plugins.find(p => p.id === 'edmore-conversation-title').enabled, false)
    assert.equal((await call('/auth/me', bob).then(r => r.json())).plugins.find(p => p.id === 'edmore-conversation-title').enabled, true)
    assert.equal((await call('/auth/users', admin, { action: 'set-disabled', username: 'admin', disabled: true })).status, 400)
    const alice2 = await login('alice')
    const stream = await call('/api/edmore/events/stream', alice)
    const reader = stream.body.getReader()
    await reader.read()
    await call('/auth/logout', alice, {})
    let streamClosed = false
    try { while (!(await reader.read()).done) {} streamClosed = true } catch { streamClosed = true }
    assert.equal(streamClosed, true)
    assert.equal((await call('/auth/me', alice)).status, 401)
    assert.equal((await call('/auth/me', alice2)).status, 200)
    await call('/auth/users', admin, { action: 'set-disabled', username: 'alice', disabled: true })
    assert.equal((await call('/auth/me', alice2)).status, 401)
    assert.equal((await call('/auth/me', bob)).status, 200)
    const oldPid = (await gateway.workers.get('bob')).child.pid
    const bobEntry = await gateway.workers.get('bob')
    bobEntry.mutations = 1
    assert.equal((await call('/api/admin/workers/restart',admin,{username:'bob'})).status,409)
    assert.equal((await call('/api/admin/apply',admin,{})).status,409)
    bobEntry.mutations = 0
    assert.equal((await call('/api/admin/workers/restart',admin,{username:'bob'})).status,200)
    assert.notEqual((await gateway.workers.get('bob')).child.pid,oldPid)
    assert.equal((await call('/api/admin/workers/restart',admin,{username:'missing'})).status,404)
    const restartedPid = (await gateway.workers.get('bob')).child.pid
    assert.equal((await call('/api/admin/plugins',admin,{id:'edmore-jev-decisions',enabled:true,apiKey:'private-shared-jev-key'})).status,200)
    assert.equal((await call('/api/admin/apply',admin,{})).status,200)
    assert.notEqual((await gateway.workers.get('bob')).child.pid,restartedPid)
    assert.ok(!(await readFile(join(home,'auth/users/bob/admin.patch.json'),'utf8')).includes('test-secret'))
    let bobCredentials = JSON.parse(await readFile(join(home,'auth/users/bob/edmore/.credentials.yaml'),'utf8'))
    assert.equal(bobCredentials.refs.TYPESAFE_API_KEY,undefined)
    assert.ok(!JSON.stringify(bobCredentials).includes('private-shared-jev-key'))
    let bobPatch = JSON.parse(await readFile(join(home,'auth/users/bob/admin.patch.json'),'utf8'))
    assert.equal(bobPatch.find(p=>p.id==='edmore-jev-decisions').disabled,true)
    const bobMe = await call('/auth/me',bob).then(r=>r.json())
    assert.deepEqual(bobMe.jev,{required:true,configured:false,available:true})
    assert.equal((await call('/auth/jev',admin,{apiKey:'must-not-be-used'})).status,403)
    assert.equal((await call('/auth/jev',bob,{apiKey:'bob-personal-jev-key'})).status,200)
    const updatedBob = await gateway.workers.get('bob')
    bobCredentials = JSON.parse(await readFile(join(home,'auth/users/bob/edmore/.credentials.yaml'),'utf8'))
    assert.equal(bobCredentials.refs.TYPESAFE_API_KEY,'bob-personal-jev-key')
    assert.notEqual(bobCredentials.refs.TYPESAFE_API_KEY,updatedBob.token)
    bobPatch = JSON.parse(await readFile(join(home,'auth/users/bob/admin.patch.json'),'utf8'))
    assert.equal(bobPatch.find(p=>p.id==='edmore-jev-decisions').disabled,false)
    assert.equal((await call('/auth/me',bob).then(r=>r.json())).jev.configured,true)
    let capabilities
    for (let attempt=0;attempt<30;attempt++) {
      capabilities = await call('/api/edmore/capabilities',bob).then(r=>r.json())
      if (capabilities.capabilities.find(p=>p.id==='edmore-jev-decisions').status === 'ready') break
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    assert.equal(capabilities.capabilities.find(p=>p.id==='edmore-jev-decisions').status,'ready')
    assert.equal((await call('/api/admin/mcp',admin,{id:'fixture',transport:'stdio',command:process.execPath,args:[resolve('packages/auth/tests/fixtures/mcp.mjs')],enabled:true})).status,200)
    let connections
    for (let attempt=0;attempt<40;attempt++) {
      connections = await call('/api/admin/connections',admin).then(r=>r.json())
      if(connections.tools?.some(t=>t.name==='mcp__fixture__ping')) break
      await new Promise(r=>setTimeout(r,250))
    }
    if (!connections.tools?.some(t=>t.name==='mcp__fixture__ping')) console.error(await readFile(join(home,'auth/users/admin/worker.log'),'utf8'))
    assert.ok(connections.tools.some(t=>t.name==='mcp__fixture__ping'))
    const userTools = await call('/api/edmore/harness/tools',bob).then(r=>r.json())
    assert.ok(!userTools.tools.some(t=>t.name==='mcp__fixture__ping'))
    const proxy = gateway.workers.modelUrl + '/jev'
    assert.equal((await fetch(proxy,{method:'POST',body:'{}'})).status,403)
    assert.equal((await fetch(proxy,{method:'POST',headers:{authorization:`Bearer ${updatedBob.token}`},body:JSON.stringify({model:'forbidden'})})).status,403)
    const updatedAdmin = await gateway.workers.get('admin')
    assert.equal((await fetch(proxy,{method:'POST',headers:{authorization:`Bearer ${updatedAdmin.token}`},body:JSON.stringify({model:'forbidden'})})).status,400)
    assert.equal((await call('/auth/jev',bob,{clear:true})).status,200)
    assert.equal((await call('/auth/me',bob).then(r=>r.json())).jev.configured,false)
    bobCredentials = JSON.parse(await readFile(join(home,'auth/users/bob/edmore/.credentials.yaml'),'utf8'))
    assert.equal(bobCredentials.refs.TYPESAFE_API_KEY,undefined)
    assert.equal((await call('/api/admin/mcp',admin,{id:'fixture',transport:'stdio',command:process.execPath,args:[resolve('packages/auth/tests/fixtures/mcp.mjs')],enabled:true,scope:'shared'})).status,200)
    assert.equal((await call('/api/admin/apply',admin,{})).status,200)
    let sharedTools
    for (let attempt=0;attempt<40;attempt++) {
      sharedTools = await call('/api/edmore/harness/tools',bob).then(r=>r.json())
      if(sharedTools.tools?.some(t=>t.name==='mcp__fixture__ping')) break
      await new Promise(r=>setTimeout(r,100))
    }
    assert.ok(sharedTools.tools.some(t=>t.name==='mcp__fixture__ping'))
    assert.equal((await call('/auth/mcp',bob,{id:'fixture',url:'https://8.8.8.8/mcp',enabled:false})).status,409)
  } finally { await gateway?.close(); await rm(home, { recursive: true, force: true }) }
})

test('admin settings validate dependencies, isolate MCP and Jev, and reject path escapes', async () => {
  const home = await mkdtemp(join(tmpdir(),'edmore-admin-'))
  try {
    const settings = new AdminSettings(resolve('.'),home)
    await assert.rejects(settings.saveSkill({category:'support',id:'../escape',name:'bad',description:'bad',content:'bad'},'admin'))
    await assert.rejects(settings.savePlugin({id:'webserver',enabled:false},'admin'))
    await settings.savePlugin({id:'edmore-jev-decisions',enabled:true,apiKey:'private-jev-key'},'admin')
    await settings.saveMcp({id:'test',transport:'stdio',command:'node',args:[],secrets:{TEST:'private-mcp-key'},enabled:true},'admin')
    const admin = await settings.workerSettings(join(home,'admin-worker'),home,true,{'edmore-plan-judge':true,'edmore-conversation-title':true})
    const userWithoutKey = await settings.workerSettings(join(home,'user-worker-without-key'),home,false,{'edmore-plan-judge':true,'edmore-conversation-title':true},false)
    const user = await settings.workerSettings(join(home,'user-worker'),home,false,{'edmore-plan-judge':true,'edmore-conversation-title':true},true)
    assert.equal(admin.jevEnabled,true); assert.equal(userWithoutKey.jevEnabled,false); assert.equal(user.jevEnabled,true)
    assert.ok(!JSON.stringify(admin).includes('private-jev-key'))
    const adminPatch = JSON.parse(await readFile(admin.path,'utf8'))
    assert.equal(adminPatch.find(p=>p.id==='edmore-jev-decisions').disabled,false)
    assert.equal(JSON.parse(await readFile(userWithoutKey.path,'utf8')).find(p=>p.id==='edmore-jev-decisions').disabled,true)
    assert.ok(JSON.stringify(adminPatch).includes('private-mcp-key'))
    assert.ok(!(await readFile(user.path,'utf8')).includes('private-mcp-key'))
    assert.ok(!JSON.stringify(await settings.view()).includes('private-jev-key'))
    await settings.savePlugin({id:'edmore-plan-judge',enabled:false},'admin')
    assert.equal((await settings.read()).plugins['edmore-jev-decisions'],false)
    await assert.rejects(settings.savePlugin({id:'edmore-jev-decisions',enabled:true},'admin'))
    await assert.rejects(settings.saveMcp({id:'bad',transport:'streamable-http',url:'file:///etc/passwd',enabled:true},'admin'))
  } finally {await rm(home,{recursive:true,force:true})}
})
