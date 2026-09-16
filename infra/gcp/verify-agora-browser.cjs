// Read-only production verification. HTTP 200 alone misses errors after hydration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.FLEET_PLAYWRIGHT_MODULE || 'playwright');
const base = 'https://fleet-governance-449245570324.us-central1.run.app';
const historical = '17758453720459259775115348801772992791284533307697182874480707147019297120429';

(async () => {
  const snapshot = await (await fetch(base + '/api/compute-policy')).json();
  // Check incomplete historical rounds honestly too. Full-run acceptance is
  // independently enforced by verify-simulation, which still requires 15 ballots.
  const ids = new Map([[historical, 5], ...(snapshot.simulationStatus?.rounds || [])
    .filter(round => ["approved", "denied"].includes(round.phase) && round.txHash && round.votes?.length)
    .map(round => [round.proposalId, round.votes.length])]);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.FLEET_BROWSER_BIN ? { executablePath: process.env.FLEET_BROWSER_BIN } : {}) });
  const verified = [];
  const reasonsByVoter = new Map();
  try {
    for (const [proposalId, expectedBallots] of ids) {
      const votes = (await (await fetch(base + '/api/archive/votes/' + proposalId)).json()).data;
      assert.equal(votes.length, expectedBallots, 'Every recorded ballot must be indexed');
      assert.equal(new Set(votes.map(vote => vote.voter.toLowerCase())).size, expectedBallots);
      for (const vote of votes) {
        let reason = vote.reason;
        try { reason = JSON.parse(reason).rationale || reason; } catch {}
        const address = vote.voter.toLowerCase();
        reasonsByVoter.set(address, [...(reasonsByVoter.get(address) || []), reason]);
      }
      const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: 'America/Toronto' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/proposals/' + proposalId, { waitUntil: 'domcontentloaded' });
      // Every reason must appear in the actual hydrated vote rows. The experiment
      // context's five names alone would pass even when those rows crash.
      await page.waitForFunction(reasons => {
        const text = document.body.innerText.replace(/\s+/g, ' ');
        return reasons.every(reason => text.includes(reason.replace(/\s+/g, ' ').slice(0, 100)));
      }, votes.map(vote => vote.reason), { timeout: 30000 });
      const content = await page.locator('body').innerText();
      assert.ok(!content.includes('This page couldn’t load'));
      for (let agent = 1; agent <= 5; agent++) assert.ok(content.includes('Agent' + agent));
      for (const [support, label] of [[1, 'FOR'], [0, 'AGAINST']]) {
        const weight = votes.filter(vote => Number(vote.support) === support)
          .reduce((sum, vote) => sum + BigInt(vote.weight), 0n);
        assert.equal(weight % 10n ** 18n, 0n, 'Pilot ballots use whole voting units');
        assert.match(content, new RegExp(label + '\\s*-\\s*' + (weight / 10n ** 18n) + '(?![0-9])'));
      }
      assert.deepEqual(errors, [], 'Hydrated proposal must not throw browser errors');
      verified.push({ proposalId, indexedBallots: votes.length, visibleReasons: votes.length,
        tallyMatchesIndexedWeights: true, browserErrors: errors });
      await page.close();
    }
    for (const [address, reasons] of reasonsByVoter) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/delegates/' + address, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-fleet-agent-profile]').waitFor();
      await page.waitForFunction(reasons => {
        const text = document.body.innerText.replace(/\s+/g, ' ');
        return reasons.every(reason => text.includes(reason.replace(/\s+/g, ' ').slice(0, 100)));
      }, reasons, { timeout: 30000 });
      assert.match(await page.locator('[data-profile-delegations]').innerText(), /self-delegated/);
      assert.deepEqual(errors, [], 'Agent profile must render its actual indexed evidence');
      await page.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync('agora-browser-evidence.json', JSON.stringify({ observedAt: new Date().toISOString(), verified,
    verifiedAgentProfiles: [...reasonsByVoter.keys()] }, null, 2));
  console.log(JSON.stringify({ event: 'agora_browser_verified', proposals: verified.length, ballots: verified.reduce((sum, row) => sum + row.indexedBallots, 0) }));
})().catch(error => { console.error(error); process.exitCode = 1; });
