import { _electron } from 'playwright'
import { createRequire } from 'node:module'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const data = await mkdtemp(join(tmpdir(), 'edmore-demo-external-ui-'))
const app = await _electron.launch({ executablePath: require('electron'), args: [resolve('.')],
  env: { ...process.env, EDMORE_DESKTOP_TEST_DATA_DIR: data } })
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('#demo-start').waitFor()
  await page.locator('#language').selectOption('zh')
  const { state } = await page.evaluate(() => window.edmore.read())
  assert.equal(await page.locator('#demo-stop-external').isVisible(), false)
  await app.evaluate(({ BrowserWindow }, state) => {
    BrowserWindow.getAllWindows()[0].webContents.send('edmore:state', {
      ...state, demo: { phase: 'stopped', externalMcp: { pid: 123, identity: 'UI fixture only' } },
    })
  }, state)
  await page.locator('#demo-stop-external').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#demo-stop-external').innerText(), '关闭外部 Demo MCP')
  assert.equal(await page.locator('#demo-stop-external').isEnabled(), true)
  assert.equal(await page.locator('#demo-stop').isDisabled(), true)
  assert.match(await page.locator('#demo-external-status').innerText(), /PID 123/)
  await mkdir(resolve('release'), { recursive: true })
  await page.screenshot({ path: resolve('release/demo-external-controls.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.deepEqual(errors, [])
  console.log('External Demo stop option renders separately from owned Demo controls; no services started or stopped.')
} finally {
  await app.close()
  await rm(data, { recursive: true, force: true })
}
