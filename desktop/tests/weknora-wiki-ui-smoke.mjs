import { _electron } from 'playwright'
import { createRequire } from 'node:module'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const data = await mkdtemp(join(tmpdir(), 'edmore-wiki-ui-'))
const app = await _electron.launch({ executablePath: require('electron'), args: [resolve('.')],
  env: { ...process.env, EDMORE_DESKTOP_TEST_DATA_DIR: data } })
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('#language').selectOption('zh')
  await page.locator('[data-tab="plugins"]').click()
  await page.waitForFunction(() => document.querySelector('#weknora-wiki-status').textContent.includes('Wiki 页面'))
  assert.equal(await page.locator('#weknora-wiki-open').isEnabled(), true)
  await app.evaluate(({ shell }) => { shell.openExternal = async url => { globalThis.__wikiOpened = url } })
  await page.locator('#weknora-wiki-open').click()
  await page.waitForTimeout(100)
  assert.match(await app.evaluate(() => globalThis.__wikiOpened), /^http:\/\/127\.0\.0\.1:8080\/platform\/knowledge-bases\/[^?]+\?tab=wiki$/)
  await mkdir(resolve('release'), { recursive: true })
  await page.screenshot({ path: resolve('release/weknora-wiki-ui.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  assert.deepEqual(errors, [])
  console.log('Wiki counts and browsing control rendered; no overflow or renderer errors. Existing services left running.')
} finally {
  await app.close()
  await rm(data, { recursive: true, force: true })
}
