import { _electron } from 'playwright'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const data = await mkdtemp(join(tmpdir(), 'edmore-demo-ui-'))
const app = await _electron.launch({ executablePath: require('electron'), args: [resolve('.')],
  env: { ...process.env, EDMORE_DESKTOP_TEST_DATA_DIR: data } })
try {
  const page = await app.firstWindow()
  await page.locator('#demo-start').waitFor()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('#demo-start').click()
  await page.waitForFunction(() => document.querySelector('#demo-status').textContent.includes('Digital Twin :8010 + HAADF Viewer :8890'), null, { timeout: 30000 })
  await page.waitForFunction(() => !document.querySelector('#demo-stop').disabled)
  await page.screenshot({ path: resolve('release/demo-ui.png'), fullPage: true })
  await page.locator('#demo-stop').click()
  await page.waitForFunction(() => !document.querySelector('#demo-start').disabled)
  assert.deepEqual(errors, [])
  console.log('Demo UI: live external services verified, stop preserves them, no renderer errors.')
} finally {
  await app.close()
  await rm(data, { recursive: true, force: true })
}
