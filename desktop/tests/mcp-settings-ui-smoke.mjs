import { chromium } from 'playwright'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const cloud of [false, true]) {
    const page = await browser.newPage()
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.route('http://localhost:13993/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/') await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main><section id="mcp"></section></main><script type="module">import { mcpEditor } from '/mcp.js'; let rows = []; window.saved=[]; const shared=${JSON.stringify(cloud ? [{id:'shared_microscope',kind:'standard',enabled:true}] : [])}; window.editor = mcpEditor(document.querySelector('#mcp'), { cloud:${cloud}, list:async()=>({rows,shared}), save:async value=>{window.saved.push(value); rows=value.remove?rows.filter(row=>row.id!==value.id):[...rows.filter(row=>row.id!==value.id),value];return {rows,shared}} });await window.editor.open();</script></body></html>` })
      else await route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : 'text/css', body: await readFile(path === '/mcp.js' ? resolve(root, 'renderer/mcp.js') : resolve(root, cloud ? '../client/packages/auth/static/style.css' : 'renderer/style.css'), 'utf8') })
    })
    await page.goto('http://localhost:13993/')
    await page.getByRole('button', {name:'Add connection'}).click()
    await page.getByLabel('Name', {exact:true}).fill('personal_microscope')
    await page.getByLabel('URL', {exact:true}).fill('https://microscope.example.org:8123/mcp')
    await page.getByRole('button', {name:'Save connection'}).click()
    await page.getByRole('button', {name:'personal_microscope',exact:true}).click()
    assert.equal(await page.getByLabel('Name',{exact:true}).getAttribute('readonly'), '')
    await page.getByLabel('URL',{exact:true}).fill('https://microscope.example.org:8124/mcp')
    await page.getByLabel('Enabled',{exact:true}).uncheck()
    await page.getByRole('button',{name:'Save connection'}).click()
    assert.equal(await page.evaluate(()=>window.saved.at(-1).enabled),false)
    assert.equal(await page.getByRole('button',{name:'shared_microscope',exact:true}).count(),0)
    await page.getByRole('button',{name:'Add connection'}).click()
    await page.getByLabel('Type',{exact:true}).selectOption('edmore')
    assert.equal(await page.getByLabel('Name',{exact:true}).inputValue(),'nionswift')
    await page.getByLabel('URL',{exact:true}).fill('https://edmore.example.org:7300')
    assert.equal(await page.locator('h2').count(), 1)
    await mkdir(resolve(root,'release'),{recursive:true})
    for (const [size,width,height] of [['desktop',1100,850],['mobile',390,844]]) {
      await page.setViewportSize({width,height})
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
      await page.screenshot({path:resolve(root,`release/mcp-${cloud?'cloud':'local'}-${size}.png`),fullPage:true})
    }
    await page.getByRole('button',{name:'Save connection'}).click()
    assert.equal(await page.evaluate(()=>window.saved.at(-1).kind),'edmore')
    await page.getByRole('button',{name:'nionswift',exact:true}).click()
    page.once('dialog',dialog=>dialog.accept())
    await page.getByRole('button',{name:'Remove',exact:true}).click()
    await page.waitForFunction(()=>window.saved.at(-1).remove===true)
    assert.deepEqual(errors,[])
    await page.close()
  }
  console.log('Local/cloud MCP editing, shared read-only scope, HTTP port, type, enable, delete and desktop/mobile layouts passed. No external services contacted.')
} finally { await browser.close() }
