import { _electron } from 'playwright'
import { createRequire } from 'node:module'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const data = await mkdtemp(join(tmpdir(), 'edmore-weknora-ui-'))
const app = await _electron.launch({ executablePath: process.env.EDMORE_TEST_EXECUTABLE || require('electron'),
  args: process.env.EDMORE_TEST_EXECUTABLE ? [] : [process.env.EDMORE_TEST_APP || resolve('.')],
  env: { ...process.env, EDMORE_DESKTOP_TEST_DATA_DIR: data } })
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('#language').selectOption('en')
  await page.locator('[data-tab="plugins"]').click()
  const toggle = page.locator('#weknora-toggle')
  await toggle.check()
  await page.waitForFunction(() => document.querySelector('#weknora-status').textContent.startsWith('Running'), null, { timeout: 60000 })
  assert.equal((await fetch('http://127.0.0.1:8080')).status, 200)
  await page.screenshot({ path: resolve('release/weknora-ui.png'), fullPage: true })
  await toggle.uncheck()
  await page.waitForFunction(() => document.querySelector('#weknora-status').textContent.startsWith('Stopped'), null, { timeout: 20000 })
  await assert.rejects(fetch('http://127.0.0.1:8080/health'))
  assert.ok((await stat(resolve('../../WeKnora-local/data/weknora.db'))).size > 0)
  assert.deepEqual(errors, [])
  console.log('Native toggle: start, HTTP 200, stop, preserved SQLite, no renderer errors.')
} finally {
  await app.close()
  await rm(data, { recursive: true, force: true })
}
