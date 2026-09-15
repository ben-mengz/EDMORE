import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const { _electron } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const dataDir = await mkdtemp(join(tmpdir(), 'edmore-desktop-ui-'))
const launch = () => _electron.launch({ executablePath: require('electron'), args: [resolve('.')], env: { ...process.env, EDMORE_DESKTOP_TEST_DATA_DIR: dataDir, DSH_HOME: join(dataDir, 'runtime') } })
let desktop = await launch()
try {
  const page = await desktop.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('#language').selectOption('en')
  await page.getByRole('button', { name: 'Open Workspace', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Plugins', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('#plugin-rows tr').length >= 15)
  const checkbox = page.locator('#plugin-rows tr').filter({ has: page.locator('small', { hasText: /^llm-deepseek$/ }) }).locator('input')
  await checkbox.uncheck()
  await page.getByText('Changes apply on the next desktop-managed start.', { exact: true }).waitFor()
  assert.equal(await checkbox.isChecked(), false)
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForFunction(() => document.getElementById('plugins-message').textContent !== 'Working…')
  assert.equal(await checkbox.isChecked(), false)
  await page.screenshot({ path: resolve('release/plugins-en.png'), fullPage: true })
  await page.getByRole('button', { name: 'Restore Profile Setting', exact: true }).click()
  await page.waitForFunction(() => document.getElementById('plugins-message').textContent !== 'Working…')
  assert.equal(await checkbox.isChecked(), true)
  await page.locator('#language').selectOption('zh')
  await page.getByRole('tab', { name: '插件', exact: true }).waitFor()
  await page.screenshot({ path: resolve('release/plugins-zh.png'), fullPage: true })
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('background').click())
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())), true)
  assert.equal(desktop.process().exitCode, null)
  await desktop.evaluate(({ app }) => app.emit('activate'))
  await page.waitForFunction(() => document.visibilityState === 'visible')
  assert.equal(await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('quit-completely').label), '完全退出')
  assert.deepEqual(errors, [])
  await desktop.close()
  desktop = await launch()
  const reopened = await desktop.firstWindow()
  await reopened.getByRole('tab', { name: '插件', exact: true }).waitFor()
  assert.equal(await reopened.locator('#language').inputValue(), 'zh')
  console.log('Passed: real profile inventory, isolated toggle persistence/reset, English/Chinese UI, background keeps process alive, reopen, persisted language.')
} finally { await desktop.close(); await rm(dataDir, { recursive: true, force: true }) }
