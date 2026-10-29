import { chromium } from 'playwright'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../../client/packages/webui/static')
const output = resolve(import.meta.dirname, '../release')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    page.setDefaultTimeout(8000)
    const calls = [], errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('http://localhost:13993/**', async route => {
      const path = new URL(route.request().url()).pathname.replace(/^\/edmore\//, '/')
      if (path === '/' || ['app.js', 'style.css'].some(file => path === '/' + file)) {
        const file = path === '/' ? 'index.html' : path.slice(1)
        await route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(resolve(root, file), 'utf8') })
      } else if (path.endsWith('/stream')) {
        await route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' })
      } else {
        if (path.endsWith('/cancel-workflow')) calls.push(route.request().postDataJSON())
        await route.fulfill({ json: { ok: true, cancelled: 1, hardware_stop_verified: true,
          workflow: { pending: [], active: [], paused: [], planning_proposals: [], instrument_leases: [] },
          runtime: 'test', activeProvider: 'test', nionswift: { ok: true, agents: [] },
          events: [], tools: [], skills: [], projects: [], conversations: [], providers: [], roles: [], capabilities: [],
        } })
      }
    })
    await page.goto('http://localhost:13993/')
    // History may contain an obsolete plan; the current snapshot is empty.
    await page.evaluate(async () => {
      const event = { event_id: 'old-plan', type: 'edmore.ui.workflow.pending_plan', session_id: sessionStorage.getItem('edmore-session-id'),
        payload: { plan: { workflow_id: 'obsolete-652', goal: 'Obsolete alignment', steps: [{ step_id: '1', goal: 'saved mag', agent: 'agent_mcp_tem_twin', tool_name: 'old_tool', arguments: {} }], judge_report: { status: 'pass' } } } }
      window.renderUiEvent(event)
      window.setPlanningProposal({ proposal_id: 'new-direction', plan_goal: 'New six-tool direction' })
      if (document.querySelector('#pending').textContent.includes('saved mag')) throw Error('Direction reused old plan')
      window.renderUiEvent({ ...event, event_id: 'old-plan-again' })
      await window.refreshPendingFromState()
      window.renderUiEvent({ ...event, event_id: 'old-plan-again' })
      if (document.querySelector('#pending').textContent.includes('saved mag')) throw Error('History resurrected obsolete plan')
    })
    const cancel = page.locator('#cancelWorkflow')
    await cancel.click()
    await page.getByText('Workflow cancelled: routing, planning, queued execution and pending plans cleared. Chat history retained.', { exact: true }).waitFor()
    assert.equal(calls.length, 1)
    assert.ok(calls[0].session_id)
    const box = await cancel.boundingBox()
    assert.ok(box && box.y < 180 && box.x >= 0 && box.x + box.width <= width)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, `workflow-cancel-${name}.png`) })
    await page.close()
  }
  console.log('Top workflow cancellation button: desktop/mobile rendering and session-scoped endpoint passed; no live workflow calls.')
} finally { await browser.close() }
