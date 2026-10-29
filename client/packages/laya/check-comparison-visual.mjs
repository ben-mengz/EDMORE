import { chromium } from '/Users/zhaomeng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const directory = '/Users/zhaomeng/.codex/visualizations/2026/09/22/01a0c96e-de7b-7c10-97ed-8a2571cc9085';
const browser = await chromium.launch({headless:true,channel:'chrome'});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [736,320]) {
    await page.setViewportSize({width,height:1200});
    await page.goto(`file://${directory}/jev-vs-laya-preview.html`);
    const frame = page.frameLocator('iframe');
    await frame.locator('.comparison-row').last().waitFor();
    if (await frame.locator('.comparison-row').count() !== 5) throw new Error('Missing chart rows');
    await frame.locator('summary').click();
    if (!await frame.locator('.example').first().isVisible()) throw new Error('Details failed');
    const overflowing = await frame.locator('#jev-laya-comparison').evaluate(root =>
      [...root.querySelectorAll('*')].filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > document.documentElement.clientWidth + 1 || r.left < -1);
      }).map(el => el.tagName + '.' + el.className));
    if (overflowing.length) throw new Error('Overflow: ' + overflowing.join(','));
    await page.screenshot({path:`${directory}/comparison-${width}.png`,fullPage:true});
    console.log(JSON.stringify({width,chartRows:5,details:'passed',overflow:0}));
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
}
