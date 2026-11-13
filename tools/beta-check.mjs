// Browser check of a test instance made by `node tools/ha-matrix.cjs up <version> <port>`: logs in, opens the test
// dashboard, switches to Russian and checks what Polyglot translated. Exits non-zero on any failure.
//
//   node tools/beta-check.mjs <version>        (needs: npm i --no-save playwright && npx playwright install chromium)
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const version = process.argv[2] || 'beta';
const dir = join(tmpdir(), 'polyglot-ha-test', version);
const session = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
const inject = readFileSync(join(dir, 'inject.js'), 'utf8');
const check = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'browser-check.js'), 'utf8');

const browser = await chromium.launch();
const context = await browser.newContext();
// Logs in before any of the page's own scripts run (stores the test tokens like the frontend does).
await context.addInitScript(inject);
const page = await context.newPage();
const warnings = [];
page.on('console', (m) => { if (m.text().includes('[polyglot]')) warnings.push(m.text()); });
page.on('pageerror', (e) => warnings.push(`page error: ${e.message}`));

await page.goto(`${session.base}/pg-test/main`);
await page.waitForFunction(() => {
  const ha = document.querySelector('home-assistant');
  return ha && ha.hass && ha.hass.states && window.__polyglot;
}, null, { timeout: 60000 });
await page.waitForTimeout(3000);
await page.evaluate((w) => { window.__pgWarn = w; }, warnings);
const res = await page.evaluate(check);
await browser.close();

const expect = {
  overlay: true,
  language: 'ru',
  active: true,
  area: 'Гостиная',
  device: 'Тестовая лампа',
  dialogDevice: session.deviceName, // settings dialogs get the original name
};
const failures = Object.entries(expect).filter(([k, v]) => res[k] !== v).map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(res[k])}`);
if (!String(res.heading).includes('Тестовый заголовок')) failures.push(`heading: ${JSON.stringify(res.heading)}`);
if (!String(res.markdown).includes('LANG=ru')) failures.push(`template language: ${JSON.stringify(res.markdown)}`);
if (warnings.length) failures.push(`console: ${warnings.join(' | ')}`);

console.log(JSON.stringify(res, null, 1));
if (failures.length) {
  console.error(`\nHome Assistant ${res.haVersion}: ${failures.length} problem(s)\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nHome Assistant ${res.haVersion}: all good`);
