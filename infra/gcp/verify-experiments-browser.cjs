// Read-only: no run creation, model calls, wallet transactions or resource changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.FLEET_PLAYWRIGHT_MODULE || 'playwright');
const base = 'https://fleet-governance-449245570324.us-central1.run.app';
(async () => {
  const index = await (await fetch(base + '/api/experiments')).json();
  assert.ok(Array.isArray(index.experiments));
  assert.equal(new Set(index.experiments.map(e => e.id)).size, index.experiments.length);
  const browser = await chromium.launch({ headless: true, ...(process.env.FLEET_BROWSER_BIN ? { executablePath: process.env.FLEET_BROWSER_BIN } : {}) });
  const errors = [], checked = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base + '/experiments', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(n => document.querySelectorAll('.experiment-row').length === n, index.experiments.length);
    assert.equal(await page.locator('#count').innerText(), String(index.experiments.length));
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.fonts.check('16px Family')), 'Agora Family font must load');
    assert.ok(await page.evaluate(() => document.querySelector('main').getBoundingClientRect().width >= innerWidth - 1), 'Experiment app keeps its full width');
    await page.goto(base + '/experiments/new', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('name').value.length > 0);
    assert.equal(await page.locator('#budget').getAttribute('max'), '1');
    await page.locator('#delegation').selectOption('false');
    assert.equal(await page.locator('#threshold').inputValue(), '1');
    assert.match(await page.locator('#create').innerText(), /Sign in/);
    for (const experiment of index.experiments.filter(e => e.kind === 'governed').slice(0, 2)) {
      await page.goto(base + experiment.url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(id => document.getElementById('run-id').innerText === id, experiment.id, { timeout: 30000 });
      if (experiment.settings) {
        await page.locator('#experiment-record').waitFor();
        assert.equal(await page.locator('#experiment-name').innerText(), experiment.settings.name);
        assert.equal(await page.locator('#agents > button').count(), experiment.agentCount);
      }
      checked.push(experiment.id);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/experiments/new', { waitUntil: 'networkidle' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile form must not overflow');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
  const evidence = { observedAt: new Date().toISOString(), experiments: index.experiments.length, checked, publicViewing: true, modelBudgetCap: 1, agoraTheme: true, fullWidth: true, mobileOverflow: false, browserErrors: errors };
  fs.writeFileSync('experiment-browser-evidence.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
})().catch(error => { console.error(error); process.exitCode = 1; });
