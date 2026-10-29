import { chromium } from 'playwright'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadSkillRoot } from '../../client/skill-format.mjs'

const root = resolve(import.meta.dirname, '../..')
const rows = (await loadSkillRoot(resolve(root, 'client/skills'))).map(row => ({ ...row, source: 'builtin' }))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://localhost:13994/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/api/admin/')) {
      assert.equal(route.request().method(), 'GET', 'UI inspection must not save settings')
      const data = path.endsWith('/skills') ? { rows } : { settings: { revision: 4, mcp: [], plugins: { 'edmore-plan-judge': true }, jevKeyConfigured: false }, workers: [] }
      await route.fulfill({ json: data })
    } else {
      const file = path === '/admin' ? 'admin.html' : path === '/admin/app.js' ? 'admin.js' : 'admin.css'
      await route.fulfill({ contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/css', body: await readFile(resolve(root, 'client/packages/auth/static', file), 'utf8') })
    }
  })
  await page.goto('http://localhost:13994/admin')
  await page.getByRole('button', { name: 'Workflows & Skills', exact: true }).click()
  await page.getByRole('button', { name: /TEM Twin Alignment Sequence/ }).click()
  assert.equal(await page.locator('#workflow-child-list li').count(), 7)
  assert.equal(await page.locator('#steps-label').isVisible(), false)
  assert.equal(await page.getByRole('button', { name: 'Duplicate', exact: true }).isDisabled(), true)
  await page.locator('#workflow-child-list').getByRole('button', { name: 'Select TEM Device', exact: true }).click()
  assert.equal(await page.getByRole('heading', { name: 'Built-in workflow', exact: true }).count(), 1)
  assert.match(await page.locator('textarea[name=steps]').inputValue(), /select_device/)
  await page.locator('#catalog-category').selectOption('support')
  assert.equal(await page.locator('#skill-form').isVisible(), false)
  await page.getByRole('button', { name: /TEM Twin Autoalignment/ }).click()
  assert.equal(await page.getByRole('heading', { name: 'Built-in skill', exact: true }).count(), 1)
  assert.equal(await page.locator('#steps-label').isVisible(), false)
  await page.getByRole('button', { name: 'New workflow', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Save workflow', exact: true }).isEnabled(), true)
  await page.getByRole('button', { name: /TEM Twin Alignment Sequence/ }).click()
  await mkdir(resolve(root, 'desktop/release'), { recursive: true })
  for (const [name, width, height] of [['desktop', 1280, 950], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.locator('#skill-list button').evaluateAll(buttons => buttons.every((button, index) => !index || button.getBoundingClientRect().top >= buttons[index - 1].getBoundingClientRect().bottom - 1)), true)
    await page.screenshot({ path: resolve(root, `desktop/release/workflow-admin-${name}.png`), fullPage: true })
  }
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  assert.equal(await page.getByText('Workflow Engine', { exact: true }).count(), 1)
  assert.deepEqual(errors, [])
  console.log('Workflow/Skill categories, compound children, plugin name and desktop/mobile layouts passed.')
} finally { await browser.close() }
