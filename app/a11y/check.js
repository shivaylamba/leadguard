// Accessibility check (Merge Forward): run axe-core on every screen in a real browser.
//   node a11y/check.js http://127.0.0.1:8080
// Fails on any serious or critical violation (WCAG 2.1 A and AA rules), in light and dark mode.
const { chromium } = require('playwright');
const axePath = require.resolve('axe-core/axe.min.js');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const SCREENS = [
  ['home', '#/', null],
  ['desk (with results)', '#/desk', async (p) => { await p.fill('#q', 'Mira'); await p.press('#q', 'Enter'); await p.waitForSelector('#results article', { timeout: 10000 }); }],
  ['walk-ups and badges', '#/badges', null],
  ['booth scanner', '#/scan', async (p) => { await p.waitForSelector('#scan', { timeout: 10000 }); }],
  ['organizer', '#/ops', async (p) => { await p.waitForSelector('#booths .card', { timeout: 15000 }); }],
  ['sponsor leads', '#/leads', async (p) => { await p.waitForSelector('#lr', { timeout: 10000 }); }],
];

(async () => {
  const browser = await chromium.launch();
  let failures = 0;
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    for (const [name, hash, prepare] of SCREENS) {
      await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle' });
      if (prepare) await prepare(page);
      await page.waitForTimeout(300);
      await page.addScriptTag({ path: axePath });
      const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
      const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
      const minor = r.violations.length - bad.length;
      console.log(`${bad.length ? 'FAIL' : 'ok  '}  [${scheme}] ${name}: ${bad.length} serious/critical, ${minor} minor`);
      for (const v of bad) {
        failures++;
        console.log(`        ${v.id}: ${v.help}`);
        for (const n of v.nodes.slice(0, 3)) console.log(`          ${n.target.join(' ')}  ${n.failureSummary.split('\n').slice(1, 2).join(' ').trim()}`);
      }
    }
    await page.close();
  }
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(2); });
