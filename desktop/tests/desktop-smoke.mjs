import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const { _electron } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const electron = process.env.ELECTRON_EXECUTABLE || require('electron')
const desktop = await _electron.launch({ executablePath: electron, args: process.env.ELECTRON_EXECUTABLE ? [] : [resolve('.')], env: { ...process.env } })
try {
  const page = await desktop.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => document.getElementById('settings').elements.root.value.length > 0)
  await page.locator('#language').selectOption('zh')
  await page.waitForFunction(() => ['外部运行', '已停止'].includes(document.getElementById('phase').textContent))
  const external = await page.locator('#phase').textContent() === '外部运行'
  if (external) {
    await page.waitForFunction(() => document.querySelectorAll('#mcp tr').length > 0)
    await page.getByRole('button', { name: '检查连接', exact: true }).click()
    await page.waitForFunction(() => !document.getElementById('probe').disabled)
  }
  assert.equal(await page.locator('#stop').isDisabled(), true)
  assert.equal(await page.locator('#start').isDisabled(), external)
  await page.screenshot({ path: resolve('release/control-panel.png'), fullPage: true })
  let workspaceUrl
  if (external) {
    const nextWindow = desktop.waitForEvent('window')
    await page.getByRole('button', { name: '打开工作区' }).click()
    const workspace = await nextWindow
    await workspace.waitForURL('**/edmore')
    await workspace.waitForLoadState('domcontentloaded')
    assert.match(workspace.url(), /127\.0\.0\.1:7380\/edmore/)
    workspaceUrl = workspace.url()
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ phase: await page.locator('#phase').textContent(), mcp: await page.locator('#mcp').innerText(), workspace: workspaceUrl, errors }))
} finally { await desktop.close() }
