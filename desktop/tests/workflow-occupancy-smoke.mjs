import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../../client/packages/webui/static')
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  await page.addInitScript(() => { window.EventSource = class { close() {} } })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const name = new URL(route.request().url()).pathname.split('/').pop() || 'index.html'
    if (!['index.html', 'app.js', 'style.css'].includes(name)) return route.fulfill({ json: { ok: true } })
    let body = await readFile(resolve(root, name), 'utf8')
    if (name === 'app.js') {
      const start = body.lastIndexOf('\nPromise.allSettled([')
      assert.ok(start > 0, 'Frontend initialization entry must exist')
      body = body.slice(0, start)
    }
    await route.fulfill({ body, contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' })
  })
  await page.goto('http://localhost/edmore/index.html')
  assert.equal(await page.locator('.side-panel > .panel').count(), 1)
  assert.equal(await page.getByLabel('Conversation model', { exact: true }).isVisible(), true)
  const modelRequest = await page.evaluate(async () => {
    const originalApi = api
    let saved
    sessionId = 'model-session'
    providerProfiles = [{ id: 'configured', displayName: 'Configured', model: 'selected-model' }]
    api = async (_path, options) => {
      if (options?.method === 'POST') saved = JSON.parse(options.body)
      return { effective: { model: 'baseline' }, override: saved || null }
    }
    await refreshConversationModel()
    conversationModel.value = JSON.stringify(['configured', 'selected-model'])
    await conversationModel.onchange()
    api = originalApi
    return saved
  })
  assert.deepEqual(modelRequest, { session_id: 'model-session', provider: 'configured', model: 'selected-model' })
  const deleted = await page.evaluate(async () => {
    const requests = []
    workspaceApi = async (path, options = {}) => {
      requests.push({ path, method: options.method || 'GET' })
      return { conversations: [] }
    }
    window.confirm = () => true
    projects = [{ id: 'test-project', name: 'Test', cwd: '/untouched' }]
    currentProjectId = 'test-project'
    conversations = [{ id: 'last', session_id: 'last-session', title: 'Last' }]
    currentConversationId = 'last'
    await deleteCurrentConversation()
    await loadConversations()
    await deleteCurrentProject()
    return { requests, currentConversationId, currentProjectId, count: conversations.length }
  })
  assert.equal(deleted.currentConversationId, null)
  assert.equal(deleted.currentProjectId, null)
  assert.equal(deleted.count, 0)
  assert.equal(deleted.requests.some(request => request.method === 'POST'), false)
  assert.ok(deleted.requests.some(request => request.method === 'DELETE' && request.path.startsWith('/projects?')))
  await page.evaluate(async () => {
    api = async () => ({ capabilities: [{ id: 'edmore-session-state-api', status: 'unavailable' }] })
    await refreshCapabilities()
  })
  assert.equal(await page.getByRole('tab', { name: 'Session State', exact: true }).count(), 0)
  await page.evaluate(async () => {
    api = async () => ({ capabilities: [{ id: 'edmore-session-state-api', status: 'ready' }] })
    await refreshCapabilities()
  })
  assert.equal(await page.getByRole('tab', { name: 'Session State', exact: true }).isVisible(), true)
  await page.evaluate(() => {
    sessionId = 'new-session'
    api = async () => ({ workflow: {
      instrument_leases: [{ instrument_id: 'nionswift:sem', session_id: 'old-session', workflow_id: 'old-workflow', state: 'paused', reason: 'Waiting for prepared parameter confirmation' }],
      active: [{ session_id: 'old-session', workflow_id: 'old-workflow', next_step_index: 0, plan: { workflow_id: 'old-workflow', steps: [{ step_id: '9', goal: 'Review parameters', agent: 'agent_ptychography', tool_name: 'append_exp_params' }] } }],
      paused: [{ session_id: 'old-session', workflow_id: 'old-workflow' }],
    } })
    startUiStream = () => {}
    return refreshPendingFromState()
  })
  assert.match(await page.locator('#instrumentOccupancy').innerText(), /old-session/)
  assert.match(await page.locator('#pending').innerText(), /No workflow/)
  await page.getByRole('button', { name: 'Open workflow', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#pending').textContent.includes('Review parameters'))
  assert.match(await page.locator('#pending').innerText(), /Paused/)
  await page.evaluate(() => {
    const oldApi = api
    api = async (path, options) => {
      if (path.includes('/edmore-session-state/state')) return { schema_version: 1, session_id: sessionId, version: 42, workflows: { 'old-workflow': { status: 'paused', gates: { '4': { event_id: 'ui-confirmed', user_reply: 'ROI confirmed' } } } } }
      if (path.includes('/edmore-session-state/events')) return { events: [{ version: 42, event: { type: 'user.resume.accepted', source: 'nionswift-ui', payload: { roi: 12 } } }], next_cursor: 42 }
      return oldApi(path, options)
    }
  })
  await page.getByRole('tab', { name: 'Session State', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#sessionStateData').textContent.includes('ui-confirmed'))
  assert.equal(await page.locator('#conversationView').isVisible(), false)
  await page.locator('#sessionStateEvents summary').first().click()
  await page.screenshot({ path: '/tmp/edmore-session-state-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 420, height: 850 })
  await page.screenshot({ path: '/tmp/edmore-session-state-mobile.png', fullPage: true })
  assert.ok(await page.locator('#sessionStateView').evaluate(element => element.scrollWidth <= element.clientWidth + 1))
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  assert.equal(await page.locator('#conversationView').isVisible(), true)
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Cancel paused workflow', exact: true }).click()
  assert.match(await page.locator('#instrumentOccupancy').innerText(), /old-session/)
  await page.evaluate(() => {
    const priorApi = api
    api = async (path, options) => {
      if (path.endsWith('/cancel-paused')) {
        const body = JSON.parse(options.body)
        if (body.workflow_id !== 'old-workflow' || body.session_id !== 'old-session' || body.hardware_stop_verified !== true) throw new Error('Wrong cancellation target')
        api = async () => ({ workflow: {} })
        return { ok: true }
      }
      return priorApi(path, options)
    }
  })
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Cancel paused workflow', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('#instrumentOccupancy').textContent.trim())
  await page.screenshot({ path: '/tmp/edmore-workflow-occupancy.png', fullPage: true })
  await page.evaluate(() => {
    currentPlan = { workflow_id: 'recovery-test', summary: 'Review diagnostic fixes', steps: [{ step_id: '5', goal: 'Find defocus', agent: 'agent_suggestion', tool_name: 'find_defocus' }] }
    currentPlanStatus = 'paused'
    setPausedWorkflow('recovery-test')
    setRecoveryChoice({ version: 'diagnostic-v1', failures: ['dose'], options: [{ id: 'fix_dose_dwell', description: 'Reduce dwell to meet the dose limit; recheck signal statistics.' }] }, '5')
    renderPlanSection()
    sendAction = async (...args) => { window.recoveryRequest = args }
  })
  assert.equal(await page.locator('#confirmWorkflow').isVisible(), false)
  await page.getByLabel('Recovery action').selectOption('fix_dose_dwell')
  await page.getByRole('button', { name: 'Run selected action', exact: true }).click()
  const request = await page.evaluate(() => window.recoveryRequest[2])
  assert.equal(request.prompt, 'fix_dose_dwell')
  assert.deepEqual(request.confirmation_context, { workflow_id: 'recovery-test', step_id: '5', version: 'diagnostic-v1' })
  await page.screenshot({ path: '/tmp/edmore-recovery-desktop.png', fullPage: true })
  await page.evaluate(() => {
    currentPlan.goal = 'A long workflow description '.repeat(80)
    currentPlan.summary = 'Full workflow context '.repeat(100)
    currentPlan.judge_report = { status: 'pass', issues: [{ message: 'Long review note '.repeat(100) }] }
    renderPlanSection()
  })
  assert.equal(await page.locator('.workflow-description').getAttribute('open'), null)
  assert.ok(await page.locator('.workflow-preview').evaluate(element => element.getBoundingClientRect().height < 50))
  await page.locator('.workflow-description > summary').click()
  assert.equal(await page.locator('.workflow-description p').isVisible(), true)
  await page.locator('.workflow-description > summary').click()
  assert.equal(await page.locator('.plan-replan p').isVisible(), false)
  const planLayout = await page.locator('#pending').evaluate(element => {
    const plan = element.getBoundingClientRect()
    const panel = element.parentElement.getBoundingClientRect()
    return { gap: panel.bottom - plan.bottom, height: plan.height, overflow: element.scrollWidth - element.clientWidth }
  })
  assert.ok(planLayout.height > 360, 'Plan fills the desktop sidebar instead of a 360px box')
  assert.ok(planLayout.gap <= 16, 'Plan reaches the sidebar bottom')
  assert.ok(planLayout.overflow <= 1, 'Plan has no horizontal overflow')
  await page.setViewportSize({ width: 420, height: 850 })
  await page.screenshot({ path: '/tmp/edmore-recovery-mobile.png', fullPage: true })
  assert.ok(await page.locator('#pending').evaluate(element => element.scrollWidth <= element.clientWidth + 1))
  assert.deepEqual(errors, [])
  console.log('PASS: occupancy, cancellation, Conversation/Session State tabs, state/event rendering, desktop/mobile. No live API calls.')
} finally { await browser.close() }
