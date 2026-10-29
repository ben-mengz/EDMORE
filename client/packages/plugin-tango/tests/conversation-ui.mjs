import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const root = new URL('../../webui/static/', import.meta.url)
const output = join(tmpdir(), 'edmore-conversation-instruments')
await mkdir(output, { recursive: true })
const selections = new Map()
let enabled = true
const server = createServer(async (req, res) => {
  if (req.url === '/api/edmore/extensions') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ extensions: enabled ? [{ id: 'tango', module: '/api/edmore/extensions/tango/panel.js' }] : [] })); return
  }
  if (req.url.startsWith('/api/edmore/extensions/tango/state')) {
    const session = new URL(req.url, 'http://x').searchParams.get('session_id')
    if (req.method === 'POST') {
      let text = ''; for await (const chunk of req) text += chunk
      const body = JSON.parse(text); selections.set(body.session_id, body.devices)
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ enabled, devices: [{ device: 'edmore/tem/twin', available: true }, { device: 'edmore/tem/offline', available: false }], selected: selections.get(session) ?? [], locked: false })); return
  }
  if (req.url === '/') {
    const html = (await readFile(new URL('index.html', root), 'utf8')).replace('<script type="module" src="/edmore/app.js"></script>', `<script type="module">import { conversationExtensions } from '/edmore/extensions.js'; window.session = 'one'; window.picker = conversationExtensions(document.querySelector('#conversationExtensions'), async (url, options) => (await fetch(url, options)).json(), () => window.session); await picker.refresh();</script>`)
    res.setHeader('content-type', 'text/html'); res.end(html); return
  }
  const file = req.url.split('/').at(-1)
  if (!['style.css', 'extensions.js', 'panel.js', 'panel.css'].includes(file)) { res.writeHead(404); res.end(); return }
  res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript')
  res.end(await readFile(['panel.js', 'panel.css'].includes(file) ? new URL(`../static/${file}`, import.meta.url) : new URL(file, root)))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  for (const [name, width, height] of [['desktop', 1366, 900], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height })
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    const box = page.getByRole('checkbox', { name: 'edmore/tem/twin', exact: true })
    await box.waitFor()
    await box.check()
    await page.waitForFunction(() => !document.querySelector('[data-devices] input').disabled)
    assert.deepEqual(selections.get('one'), ['edmore/tem/twin'])
    await page.evaluate(async () => { window.session = 'two'; await picker.refresh() })
    assert.equal(await box.isChecked(), false)
    await page.evaluate(async () => { window.session = 'one'; await picker.refresh() })
    assert.equal(await box.isChecked(), true)
    assert.equal(await page.getByRole('checkbox', { name: 'edmore/tem/offline (unavailable)', exact: true }).isDisabled(), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true })
    enabled = false
    await page.evaluate(() => picker.refresh())
    assert.equal(await page.locator('#conversationInstruments').isVisible(), false)
    enabled = true
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ output, viewports: ['desktop', 'mobile'], errors }))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
