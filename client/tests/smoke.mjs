import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'edmore-client-test-'))
const baselinePatch = join(home, 'test-baseline.json')
const socket = createServer()
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise(resolve => socket.close(resolve))
const base = `http://127.0.0.1:${port}`
let child, exited, logs = ''
const modelRequests = []
const modelServer = createHttpServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  modelRequests.push(JSON.parse(body))
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (JSON.stringify(modelRequests.at(-1).messages.at(-1)).includes('SLOW_CANCEL')) {
    res.flushHeaders()
    return
  }
  const chunk = (delta, finish_reason = null) => ({ id: 'local-test', object: 'chat.completion.chunk', created: 1, model: 'local-model', choices: [{ index: 0, delta, finish_reason }] })
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'LOCAL_MODEL_OK' }))}\n\n`)
  res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
async function start(extraArgs = [], healthPath = '/api/edmore/health') {
  logs = ''
  child = spawn(process.execPath, ['--import', 'tsx/esm', 'start.mjs', '--patch', baselinePatch, ...extraArgs], {
    cwd: root,
    env: { ...process.env, DSH_HOME: home, EDMORE_CLIENT_PORT: String(port),
      EDMORE_NIONSWIFT_BASE_URL: 'http://127.0.0.1:1', EDMORE_WORKSPACE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  exited = new Promise(resolve => child.once('exit', resolve))
  child.stdout.on('data', data => { logs += data })
  child.stderr.on('data', data => { logs += data })
  for (let i = 0; i < 150; i++) {
    if (healthPath === null && logs.includes('CORE_NO_HTTP_READY')) return
    try {
      const response = await fetch(`${base}${healthPath}`)
      if (response.ok) {
        const health = await response.json()
        assert.equal(health.ok, true)
        assert.equal(health.nionswift.ok, false)
        if (healthPath === '/api/edmore/health') {
          const status = await (await fetch(`${base}/api/edmore/capabilities`)).json()
          if (status.capabilities.some(row => ['loading', 'blocked'].includes(row.status))) { await delay(100); continue }
        }
        return
      }
    } catch {}
    if (child.exitCode !== null) break
    await delay(100)
  }
  throw new Error(`Client failed to start:\n${logs}`)
}
async function stop() {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  try { assert.equal(await exited, 0, logs) } finally { clearTimeout(timer) }
}
async function api(path, body) {
  const response = await fetch(base + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal(response.ok, true, await response.clone().text())
  return response.json()
}
try {
  await writeFile(baselinePatch, JSON.stringify([{ id: 'edmore-jev-decisions', disabled: true }]))
  await mkdir(join(home, 'edmore'), { recursive: true })
  await writeFile(join(home, 'edmore/events.jsonl'), JSON.stringify({ event_id: 'state-fixture', cursor: 1,
    timestamp: '2026-09-15T00:00:00Z', source: 'test', type: 'edmore.custom.ui_input', scope: 'workflow',
    session_id: 'state-test', workflow_id: 'fixture-workflow', payload: { text: 'User fixture, no execution' },
  }) + '\n')
  await start()
  assert.ok((await api('/api/edmore/extensions')).extensions.some(row => row.id === 'tango'))
  const instruments = await api('/api/edmore/extensions/tango/state?session_id=instrument-smoke')
  assert.equal(instruments.enabled, true)
  assert.deepEqual(instruments.selected, [])
  assert.ok(instruments.error)
  await api('/api/edmore/extensions/tango/state', { session_id: 'instrument-smoke', devices: [] })
  const roles = await api('/api/edmore/agent-roles')
  assert.equal(roles.roles.planner.timeoutMs, 300000)
  assert.equal(roles.roles.orchestrator.timeoutMs, 60000)
  await api('/api/edmore/agent-roles', { role: 'planner', timeoutMs: 120000 })
  assert.equal((await api('/api/edmore/agent-roles')).roles.planner.timeoutMs, 120000)
  const projects = await api('/api/edmore-workspace/projects')
  const project = projects.projects[0]
  assert.ok(project.id)
  const created = await api('/api/edmore-workspace/conversations', { project_id: project.id, title: 'Persistence check' })
  assert.ok(created.conversation.id)
  const sessionId = 'state-test'
  const sessionState = await api(`/api/edmore-session-state/state?session_id=${encodeURIComponent(sessionId)}`)
  assert.equal(sessionState.schema_version, 1)
  const controller = new AbortController()
  const stream = await fetch(`${base}/api/edmore-session-state/stream?session_id=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
  assert.ok(stream.headers.get('content-type').includes('text/event-stream'))
  const notification = await stream.body.getReader().read()
  assert.ok(new TextDecoder().decode(notification.value).includes('state-test'))
  controller.abort()
  const journal = await api(`/api/edmore-session-state/events?session_id=${encodeURIComponent(sessionId)}`)
  assert.ok(journal.events.some(row => row.event.session_id === sessionId))
  const trajectory = await (await fetch(`${base}/api/edmore-session-state/export?session_id=${encodeURIComponent(sessionId)}`)).text()
  assert.equal(JSON.parse(trajectory.split('\n')[0]).schema, 'edmore.session-trajectory')
  const skills = await api('/api/edmore/skills')
  assert.ok(JSON.stringify(skills).includes('ptychography'))
  assert.equal((await fetch(`${base}/edmore/`)).status, 200)
  await stop()
  await start()
  const noTangoHome = join(home, 'edmore/features.json')
  await stop()
  await writeFile(noTangoHome, JSON.stringify({ version: 1, disabled: ['tango'] }))
  await start()
  assert.deepEqual((await api('/api/edmore/extensions')).extensions, [])
  assert.equal((await fetch(base + '/edmore/')).status, 200)
  assert.equal((await fetch(base + '/api/edmore/extensions/tango/panel.js')).status, 404)
  await stop()
  await writeFile(noTangoHome, JSON.stringify({ version: 1, disabled: [] }))
  await start()
  const restored = await api(`/api/edmore-workspace/conversations?project_id=${encodeURIComponent(project.id)}`)
  assert.ok(restored.conversations.some(item => item.id === created.conversation.id))
  const replayed = await api(`/api/edmore-session-state/events?session_id=${encodeURIComponent(sessionId)}`)
  assert.deepEqual(replayed.events.slice(0, journal.events.length), journal.events)
  const capabilities = await api('/api/edmore/capabilities')
  assert.equal(capabilities.capabilities.find(row => row.id === 'edmore-session-state-api').status, 'ready')
  assert.equal(capabilities.capabilities.find(row => row.id === 'edmore-jev-decisions').status, 'unavailable')
  await stop()
  const jevPatch = join(home, 'enable-jev.json')
  const judgeProbe = join(home, 'judge-probe.mjs')
  await writeFile(judgeProbe, `export const inject = ['webServer', 'edmorePlanJudge', 'tools'];
export function apply(ctx) { ctx.effect(() => ctx.webServer.register({kind:'prefix',path:'/test-judge',handler:async (req,res)=>{
if(req.url.endsWith('/disable')) await ctx.edmorePlanJudge.disable('Injected Judge failure');
res.setHeader('content-type','application/json'); res.end(JSON.stringify({tools:ctx.tools.schemas().map(tool=>tool.name)}));
}}), 'test.judge-failure'); }`)
  await writeFile(jevPatch, JSON.stringify([{ id: 'edmore-jev-decisions', disabled: false }, { insert: [{ id: 'judge-probe', name: judgeProbe }] }]))
  await start(['--patch', jevPatch])
  const withJev = await api('/api/edmore/capabilities')
  assert.equal(withJev.capabilities.find(row => row.id === 'edmore-jev-decisions').status, 'ready')
  assert.equal(withJev.capabilities.find(row => row.id === 'edmore-plan-judge').status, 'ready')
  assert.ok((await api('/test-judge/tools')).tools.includes('edmore_request_workflow_mode'))
  assert.equal((await api('/test-judge/disable')).tools.includes('edmore_request_workflow_mode'), false)
  assert.equal((await api('/api/edmore/capabilities')).capabilities.find(row => row.id === 'edmore-plan-judge').status, 'failed')
  console.log('PASS: Judge failure changes capability health and removes its mode tool')
  await stop()
  const patch = join(home, 'no-state-view.json')
  await writeFile(patch, JSON.stringify([{ id: 'edmore-session-state-api', disabled: true }]))
  await start(['--patch', patch])
  assert.equal((await fetch(`${base}/api/edmore-session-state/state?session_id=state-test`)).status, 404)
  const withoutView = await api('/api/edmore/capabilities')
  assert.equal(withoutView.capabilities.find(row => row.id === 'edmore-session-state-api').status, 'unavailable')
  assert.equal(withoutView.capabilities.find(row => row.id === 'edmore-session-state').status, 'ready')
  assert.equal(withoutView.capabilities.find(row => row.id === 'edmore-plan-judge').status, 'ready')
  assert.equal((await api('/api/edmore/ui/state?session_id=state-test')).session_state.schema_version, 1)
  console.log('PASS: state viewer disabled while evidence, workflow, UI API and Core stay available')
  await stop()
  const noWorkflow = join(home, 'no-workflow.json')
  await writeFile(noWorkflow, JSON.stringify(['edmore-plan-judge', 'edmore-session-state', 'edmore-session-state-api'].map(id => ({ id, disabled: true }))))
  await start(['--patch', noWorkflow])
  const minimal = await api('/api/edmore/capabilities')
  assert.equal(minimal.capabilities.find(row => row.id === 'edmore-plan-judge').status, 'unavailable')
  assert.equal(minimal.capabilities.find(row => row.id === 'edmore-backend').status, 'ready')
  assert.equal((await api('/api/edmore/harness/tools')).tools.some(row => row.name === 'edmore_request_workflow_mode'), false)
  await api('/api/edmore/actions/trigger', { prompt: 'must not execute', plan_mode: true, session_id: 'no-judge-plan' })
  for (let i = 0; i < 30; i++) {
    const result = await api('/api/edmore/events?session_id=no-judge-plan&after=0&limit=100')
    if (result.events.some(event => event.type === 'edmore.assistant.completed' && event.payload.text.includes('No action was executed'))) break
    assert.ok(i < 29, 'Stale Workflow request was not explicitly rejected')
    await delay(100)
  }
  assert.deepEqual((await api('/api/edmore/ui/state?session_id=state-test')).workflow, {})
  const referenceCatalog = (await api('/api/edmore/skills')).skills
  assert.ok(referenceCatalog.some(row => row.category === 'workflow'))
  assert.ok(referenceCatalog.some(row => row.category === 'support'))
  const denied = await fetch(`${base}/api/edmore/actions/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow_id: 'not-a-plan', session_id: 'one', action_id: 'disabled-approval' }) })
  assert.equal(denied.ok, false)
  assert.match(await denied.text(), /Workflow capability is unavailable/)
  console.log('PASS: workflow and evidence disabled; runtime, skills, UI survive; approval denied')
  await api('/api/edmore/llm/providers', { id: 'openai', model: 'gpt-5-mini', baseURL: `http://127.0.0.1:${modelServer.address().port}/v1`, api: 'openai-completions', apiKey: 'local-test-only' })
  await api('/api/edmore/llm/active', { provider: 'openai' })
  await api('/api/edmore/agent-roles', { role: 'orchestrator', provider: 'openai', model: 'gpt-5-mini', timeoutMs: 10000 })
  const chosenModel = await api('/api/edmore/conversation-model', { session_id: 'model-choice-test', provider: 'openai', model: 'gpt-5-mini' })
  assert.equal(chosenModel.override.model, 'gpt-5-mini')
  assert.equal((await api('/api/edmore/conversation-model?session_id=unrelated')).override, null)
  await stop()
  const reviewProbe = join(home, 'review-probe.mjs')
  await writeFile(reviewProbe, `export const inject = ['webServer', 'edmoreAgentLoop'];
export function apply(ctx) { ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/review-probe', handler: async (_req, res) => {
try { const text = await ctx.edmoreAgentLoop.runRoleOnce('review-test', 'orchestrator', 'ISOLATED_REVIEW_TEST', {event_id:'review-test',cursor:0,timestamp:new Date().toISOString(),source:'test',type:'test',scope:'workflow',session_id:'review-test',payload:{}});
res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({text})); } catch(error) {res.writeHead(500);res.end(String(error));}
} }), 'test.review'); }`)
  const reviewPatch = join(home, 'review-patch.json')
  await writeFile(reviewPatch, JSON.stringify([{ id: 'edmore-plan-judge', disabled: true }, { insert: [{ id: 'review-probe', name: reviewProbe }] }]))
  await start(['--patch', reviewPatch])
  assert.equal((await api('/api/edmore/conversation-model?session_id=model-choice-test')).override.model, 'gpt-5-mini')
  for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/review-probe`)).status, 200)
  const reviewEvents = (await api('/api/edmore/events?session_id=review-test&after=0&limit=1000')).events
  const reviewSessions = reviewEvents.filter(event => event.type === 'edmore.custom.agent_loop_session.created')
  assert.equal(new Set(reviewSessions.map(event => event.payload.harness_session_id)).size, 2)
  console.log('PASS: independent review calls create distinct native sessions with read-only evidence tools')
  modelRequests.length = 0
  await stop()
  await start(['--patch', noWorkflow])
  async function chat(prompt) {
    const receipt = await api('/api/edmore/actions/trigger', { prompt, session_id: 'native-loop-test' })
    for (let i = 0; i < 150; i++) {
      const { events } = await api('/api/edmore/events?session_id=native-loop-test&after=0&limit=1000')
      const result = events.find(event => event.correlation_id === receipt.event.event_id && ['edmore.assistant.completed', 'edmore.assistant.failed'].includes(event.type))
      if (result) {
        assert.equal(result.type, 'edmore.assistant.completed', JSON.stringify(result))
        assert.match(result.payload.text, /LOCAL_MODEL_OK/)
        return result.payload.session_id
      }
      await delay(100)
    }
    throw new Error(`Native loop did not reply: ${logs}`)
  }
  const nativeSession = await chat('FIRST_LOCAL_QUERY')
  await stop()
  await start(['--patch', noWorkflow])
  assert.equal(await chat('SECOND_LOCAL_QUERY'), nativeSession)
  assert.equal(modelRequests.length, 2)
  assert.match(JSON.stringify(modelRequests[1].messages), /FIRST_LOCAL_QUERY/)
  console.log('PASS: native Harness loop replies without workflow and restores same session/context after restart using local model server')
  await stop()
  const minimalPatch = join(home, 'minimal.json')
  const disabled = ['edmore-plan-judge', 'edmore-session-state', 'edmore-session-state-api', 'edmore-mcp-bridge', 'edmore-workspace', 'edmore-workspace-api', 'edmore-conversation-title', 'edmore-webui']
  await writeFile(minimalPatch, JSON.stringify(disabled.map(id => ({ id, disabled: true }))))
  await start(['--patch', minimalPatch])
  const reduced = await api('/api/edmore/capabilities')
  for (const id of disabled) assert.equal(reduced.capabilities.find(row => row.id === id).status, 'unavailable', id)
  assert.equal((await fetch(`${base}/edmore/`)).status, 404)
  assert.equal((await fetch(`${base}/api/edmore-workspace/projects`)).status, 404)
  let computerUseTools = []
  const expectComputerUse = process.platform === 'darwin' && process.env.EDMORE_DISABLE_COMPUTER_USE !== '1'
  for (let i = 0; i < (expectComputerUse ? 100 : 1) && computerUseTools.length < 40; i++) {
    computerUseTools = (await api('/api/edmore/harness/tools')).tools.map(tool => tool.name)
    if (computerUseTools.length < 40) await delay(50)
  }
  if (expectComputerUse) {
    assert.ok(computerUseTools.length >= 40)
    for (const name of ['list_apps', 'list_windows', 'get_window_state', 'click', 'type_text', 'press_key', 'hotkey']) {
      assert.ok(computerUseTools.includes(`mcp__cua-driver-mcp__${name}`), name)
    }
  } else assert.equal(computerUseTools.some(name => name.startsWith('mcp__cua-driver-mcp__')), false)
  assert.equal(await chat('NO_OPTIONAL_PLUGINS'), nativeSession)
  const slow = await api('/api/edmore/actions/trigger', { prompt: 'SLOW_CANCEL', session_id: 'native-loop-test' })
  for (let i = 0; i < 100 && !JSON.stringify(modelRequests.at(-1)?.messages.at(-1)).includes('SLOW_CANCEL'); i++) await delay(50)
  assert.match(JSON.stringify(modelRequests.at(-1).messages.at(-1)), /SLOW_CANCEL/)
  await api('/api/edmore/actions/trigger', { prompt: 'QUEUED_MUST_NOT_RUN', session_id: 'native-loop-test' })
  const cancelled = await api('/api/edmore/actions/cancel', { session_id: 'native-loop-test', action_id: 'cancel-native-loop' })
  assert.ok(cancelled.result.cancelled >= 1)
  assert.equal(cancelled.result.hardware_stop_verified, false)
  for (let i = 0; i < 100; i++) {
    const { events } = await api('/api/edmore/events?session_id=native-loop-test&after=0&limit=1000')
    if (events.some(event => event.correlation_id === slow.event.event_id && event.type === 'edmore.assistant.failed')) break
    await delay(50)
    if (i === 99) throw new Error('Cancelled native turn did not settle')
  }
  assert.equal(modelRequests.some(request => JSON.stringify(request.messages.at(-1)).includes('QUEUED_MUST_NOT_RUN')), false)
  assert.equal(await chat('AFTER_CANCEL'), nativeSession)
  console.log('PASS: native cancellation settles running turn, suppresses queued request, accepts a subsequent query')
  await stop()
  const failingPlugin = join(home, 'failing-feature.mjs')
  await writeFile(failingPlugin, `export const inject = ['webServer']; export function apply(ctx) { ctx.effect(() => ctx.webServer.register({kind:'prefix',path:'/must-not-leak',handler:(_req,res)=>res.end('leaked')}), 'test.partial-route'); throw new Error('Injected optional failure'); }`)
  const failurePatch = join(home, 'failed-feature.json')
  await writeFile(failurePatch, JSON.stringify(disabled.map(id => ({ id, disabled: true })).concat([{ id: 'edmore-webui', disabled: false, config: { id: 'edmore-webui', module: failingPlugin } }])))
  await start(['--patch', failurePatch])
  const failedFeature = (await api('/api/edmore/capabilities')).capabilities.find(row => row.id === 'edmore-webui')
  assert.equal(failedFeature.status, 'failed')
  assert.match(failedFeature.error, /Injected optional failure/)
  assert.equal((await fetch(`${base}/must-not-leak`)).status, 404)
  assert.equal(await chat('FAILED_OPTIONAL_FEATURE'), nativeSession)
  console.log('PASS: optional startup failure is reported, partial routes disposed, native chat remains available')
  await stop()
  const probe = join(home, 'core-probe.mjs')
  await writeFile(probe, `export const inject = ['webServer', 'edmoreAgentLoop', 'edmoreNionSwift'];
export function apply(ctx) { ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/core-probe', handler: async (_req, res) => { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true,nionswift:await ctx.edmoreNionSwift.status()})); } }), 'test.probe'); }`)
  const coreOnly = join(home, 'core-only.json')
  await writeFile(coreOnly, JSON.stringify([...disabled, 'edmore-backend'].map(id => ({ id, disabled: true })).concat([{ insert: [{ id: 'core-probe', name: probe }] }])))
  await start(['--patch', coreOnly], '/core-probe')
  assert.equal((await fetch(`${base}/api/edmore/health`)).status, 404)
  console.log('PASS: no MCP/workspace/title/WebUI conversation works; disabling HTTP adapter preserves Core services')
  await stop()
  const noHttpProbe = join(home, 'no-http-probe.mjs')
  await writeFile(noHttpProbe, `export const inject = ['edmoreAgentLoop']; export function apply(ctx) { ctx.inject(['edmoreWorkspace'], child => { if(child.get('webServer')) throw new Error('Unexpected web server'); if(!child.edmoreWorkspace.listProjects().length) throw new Error('Workspace missing'); console.log('CORE_NO_HTTP_READY'); }); }`)
  const noHttp = join(home, 'no-http.json')
  await writeFile(noHttp, JSON.stringify([...disabled, 'edmore-backend', 'webserver'].map(id => ({ id, disabled: id !== 'edmore-workspace' })).concat([{ insert: [{ id: 'no-http-probe', name: noHttpProbe }] }])))
  await start(['--patch', noHttp], null)
  console.log('PASS: Core and workspace metadata load without any HTTP server')
  console.log('PASS: startup, offline MCP, skills, UI, session-state API/export/replay, conversation persistence, restart, shutdown')
} finally {
  await stop()
  await new Promise(resolve => modelServer.close(resolve))
  await rm(home, { recursive: true, force: true })
}
