import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const output = join(tmpdir(), 'edmore-tango-ui')
await mkdir(output, { recursive: true })
const submissions = []
let refreshes = 0
const state = { admin: true, devices: [
  { device: 'edmore/tem/alice', owner: 'local:alice', owner_label: 'alice', mine: true, permission: 'operate', registered: true },
  { device: 'edmore/tem/shared', owner: 'local:bob', owner_label: 'bob', permission: 'read', registered: true },
  { device: 'edmore/tem/twin', unclaimed: true, registered: true },
], shares: [{ device: 'edmore/tem/alice', target: 'local:'+'a'.repeat(64), target_label: 'bob', permission: 'read', status: 'pending', id: 'request1' }] }
const server = createServer(async (req, res) => {
  if (req.url === '/auth/tango/devices') {
    let body = ''; for await (const part of req) body += part
    if (body) submissions.push(JSON.parse(body))
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body ? { ok: true } : state)); return
  }
  if (req.url === '/auth/tango/refresh') {
    refreshes++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'running' })); return
  }
  const assets = { '/devices': ['../static/devices.html', 'text/html'], '/auth/tango/devices.js': ['../static/devices.js', 'text/javascript'], '/auth/tango/devices.css': ['../static/devices.css', 'text/css'], '/auth/style.css': ['../../auth/static/style.css', 'text/css'] }
  const asset = assets[req.url]
  if (!asset) { res.writeHead(404); res.end(); return }
  res.setHeader('content-type', asset[1]); res.end(await readFile(new URL(asset[0], import.meta.url)))
})
await new Promise(ok => server.listen(0, '127.0.0.1', ok))
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
try {
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  for (const [name, width, height] of [['desktop', 1280, 960], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height })
    await page.goto(`http://127.0.0.1:${server.address().port}/devices`)
    await page.getByRole('heading', { name: 'edmore/tem/alice', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true })
  }
  await page.locator('#pair input').fill('one-use-code')
  await page.getByRole('button', { name: 'Approve connection', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Connection saved. Harness tools refreshed.' }).waitFor()
  assert.deepEqual(submissions[0], { action: 'claim', code: 'one-use-code' })
  await page.getByRole('button', { name: 'Approve sharing', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('button').disabled)
  assert.equal(submissions.at(-1).action, 'approve-share')
  await page.getByRole('button', { name: 'Block new calls', exact: true }).first().click()
  await page.getByRole('status').filter({ hasText: 'in-flight' }).waitFor()
  assert.equal(submissions.at(-1).action, 'block')
  assert.ok(refreshes >= 3, 'Existing devices and a successful claim must refresh tools')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ output, submissions: submissions.length, viewports: ['desktop', 'mobile'], errors }))
} finally {
  await browser.close()
  await new Promise(ok => server.close(ok))
}
