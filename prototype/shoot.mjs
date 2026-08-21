/**
 * Screenshot harness — renders the prototype in headless Chrome at the design
 * width so the layout questions can actually be looked at rather than reasoned
 * about. Not part of the prototype; a tool for judging it.
 *
 * Run: node shoot.mjs [outdir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = resolve(process.argv[2] ?? 'shots');
mkdirSync(OUT, { recursive: true });

const PORT = 9222;
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--no-first-run',
  '--user-data-dir=/tmp/cashflow-shoot-profile',
  'about:blank',
]);
chrome.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Chrome did not start');
}

const url = await wsUrl();
const ws = new WebSocket(url);
await new Promise((r) => ws.addEventListener('open', r));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise((res) => {
    pending.set(msgId, res);
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}

const { result: target } = await send('Target.createTarget', { url: 'about:blank' });
const { result: attached } = await send('Target.attachToTarget', {
  targetId: target.targetId,
  flatten: true,
});
const session = attached.sessionId;

await send('Page.enable', {}, session);
await send('Runtime.enable', {}, session);

async function goto(pageUrl, width, height) {
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false },
    session,
  );
  await send('Page.navigate', { url: pageUrl }, session);
  await sleep(2600);
}

async function evaluate(expression) {
  const { result } = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    session,
  );
  return result?.result?.value;
}

async function shoot(name, { fullPage = true } = {}) {
  const params = { format: 'png', captureBeyondViewport: fullPage };
  if (fullPage) {
    const dims = await evaluate(
      'JSON.stringify({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})',
    );
    const { w, h } = JSON.parse(dims);
    params.clip = { x: 0, y: 0, width: w, height: h, scale: 1 };
  }
  const { result } = await send('Page.captureScreenshot', params, session);
  writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
  console.log(`wrote ${name}.png`);
}

const BASE = 'http://localhost:5173';

console.log('— console errors are reported below each shot —');

const shots = [
  // The default: current year alone, everyday only, light theme.
  { name: '01-default-1280', url: `${BASE}/`, w: 1280, h: 1200 },
  // Multi-year, so the monthly/annual toggle appears.
  { name: '02-three-years', url: `${BASE}/?years=2023,2024,2025`, w: 1280, h: 1200 },
  // Annual granularity across three years.
  { name: '03-annual', url: `${BASE}/?years=2023,2024,2025&gran=annual`, w: 1280, h: 1200 },
  // Investing included — the churn is ~10× the everyday signal.
  { name: '04-investing-2025', url: `${BASE}/?years=2025&investing=1`, w: 1280, h: 1200 },
  // The 768px doesn't-break floor.
  { name: '05-narrow-768', url: `${BASE}/?years=2025`, w: 768, h: 1100 },
];

for (const s of shots) {
  await goto(s.url, s.w, s.h);
  const errs = await evaluate(
    '(() => { const e = window.__errs || []; return JSON.stringify(e); })()',
  );
  await shoot(s.name);
  const title = await evaluate('document.querySelector(".loading") ? "STILL LOADING" : "rendered"');
  console.log(`  ${s.name}: ${title}${errs && errs !== '[]' ? ` errors=${errs}` : ''}`);
}

// The drawer shot is produced by drawer-probe.mjs, which locates a real bar via
// zrender and reports whether the drawer opened. Guessing pixel coordinates here
// silently produced an empty "06-drawer.png" that looked like a broken drawer.
console.log('  drawer: see `node drawer-probe.mjs` (writes shots/06-drawer.png)');

// Dark theme.
await goto(`${BASE}/?years=2025`, 1280, 1200);
await evaluate(`(() => {
  localStorage.setItem('cashflow-prototype:theme','dark');
  return true;
})()`);
await goto(`${BASE}/?years=2025`, 1280, 1200);
await shoot('07-dark');

// All four years, investing on — the busiest state.
await goto(`${BASE}/?years=2023,2024,2025,2026&investing=1`, 1280, 1400);
await shoot('08-everything');

await send('Browser.close');
ws.close();
chrome.kill();
console.log(`\nshots in ${OUT}`);
process.exit(0);
