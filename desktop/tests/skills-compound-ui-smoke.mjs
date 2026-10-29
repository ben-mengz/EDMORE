import { chromium } from 'playwright'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadSkillRoot } from '../../client/skill-format.mjs'

const root = resolve(import.meta.dirname, '..')
const rows = (await loadSkillRoot(resolve(root, '../client/skills'))).map(row => ({ ...row, source: 'builtin' }))
rows.push({ id: 'test_broken', name: 'Broken references', kind: 'compound_workflow', source: 'builtin', references: ['missing_skill', 'test_broken'] })
rows.push({ id: 'test_nested', name: 'Nested reference', kind: 'compound_workflow', source: 'builtin', references: ['tem_twin_alignment_sequence'] })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://localhost:13992/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><nav><button data-tab="skills">Skills</button></nav><main><section id="view-skills"></section></main><script type="module">import { skillsView } from "/skills.js"; window.skillsView = skillsView; await skillsView.open();</script></body></html>' })
    } else if (['/skills.js', '/style.css'].includes(path)) {
      await route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : 'text/css', body: await readFile(resolve(root, `renderer${path}`), 'utf8') })
    } else await route.abort()
  })
  await page.addInitScript(rows => {
    window.edmore = { skills: async method => {
      if (method === 'list') return { rows, warnings: [] }
      if (method === 'tools') return []
      throw new Error(`Unexpected mutation: ${method}`)
    } }
  }, rows)
  await page.goto('http://localhost:13992/')
  await page.getByRole('button', { name: /TEM Twin Alignment Sequence/ }).click()
  const children = page.locator('.skill-editor form > .skill-children > .skill-child')
  assert.equal(await children.count(), 7)
  assert.equal(await page.locator('.skill-child[open]').count(), 0)
  assert.equal(await page.locator('.skill-step').count(), 0)
  assert.match(await page.locator('.skill-list-item[aria-pressed=true]').innerText(), /7 child workflows/)
  assert.equal(await page.getByRole('button', { name: 'Duplicate', exact: true }).isDisabled(), true)
  await children.first().locator('summary').first().click()
  await page.waitForSelector('.skill-child-content .skill-step')
  const selector = rows.find(row => row.id === 'tem_tango_device_selection')
  assert.equal(await children.first().locator('.skill-step').count(), selector.steps.length)
  assert.equal(await children.first().locator('.skill-step[open]').count(), 0)
  await children.first().locator('.skill-step > summary').first().click()
  assert.equal(await children.first().locator('.skill-step input').first().isDisabled(), true)
  await children.first().locator('summary').first().click()
  assert.equal(await children.first().locator('.skill-step').first().isVisible(), false)

  await mkdir(resolve(root, 'release'), { recursive: true })
  await page.evaluate(() => window.skillsView.translate('zh'))
  for (const [name, width, height] of [['desktop', 1280, 950], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height })
    if (name === 'mobile') await page.locator('.skill-editor form > .skill-children').scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(root, `release/skills-compound-${name}.png`), fullPage: name !== 'mobile' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  await page.setViewportSize({ width: 1280, height: 950 })
  await children.first().locator('summary').first().click()
  await page.waitForSelector('.skill-child-content .skill-step')
  await page.screenshot({ path: resolve(root, 'release/skills-compound-expanded.png'), fullPage: true })
  await page.getByRole('button', { name: /Nested reference/ }).click()
  await page.locator('.skill-child > summary').first().click()
  await page.waitForSelector('.skill-child-content .skill-child')
  assert.equal(await page.locator('.skill-child-content > .skill-children > .skill-child').count(), 7)
  await page.getByRole('button', { name: /Broken references/ }).click()
  assert.equal(await page.locator('.skill-reference-error').count(), 2)
  await page.getByRole('button', { name: /Beam shift and C2 aperture Phase/ }).click()
  assert.equal(await page.locator('.skill-child').count(), 0)
  assert.equal(await page.locator('.skill-step').count(), 1)
  assert.equal(await page.locator('.skill-step[open]').count(), 1)
  assert.deepEqual(errors, [])
  console.log('Compound hierarchy, lazy expansion, nested/missing/cyclic references, read-only controls, leaf workflow and desktop/mobile layouts passed; no MCP calls.')
} finally { await browser.close() }
