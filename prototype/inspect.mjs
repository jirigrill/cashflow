/**
 * DOM introspection — verifies the prototype actually rendered (charts have
 * content, strip has figures, drawer opens) rather than trusting a screenshot.
 *
 * Run: node inspect.mjs '<url>'
 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9223;
const { spawn } = await import('node:child_process');

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--user-data-dir=/tmp/cashflow-inspect-profile',
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

const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener('open', r));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const msgId = ++id;
    pending.set(msgId, res);
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });

const { result: target } = await send('Target.createTarget', { url: 'about:blank' });
const { result: att } = await send('Target.attachToTarget', {
  targetId: target.targetId,
  flatten: true,
});
const session = att.sessionId;
await send('Page.enable', {}, session);
await send('Runtime.enable', {}, session);
await send('Log.enable', {}, session);

const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Log.entryAdded') logs.push(m.params.entry.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description ?? ''));
  }
});

const evaluate = async (expression) => {
  const { result } = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    session,
  );
  if (result?.exceptionDetails) return `EXCEPTION: ${result.exceptionDetails.text}`;
  return result?.result?.value;
};

await send(
  'Emulation.setDeviceMetricsOverride',
  { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false },
  session,
);
const url = process.argv[2] ?? 'http://localhost:5173/';
await send('Page.navigate', { url }, session);
await sleep(3000);

const report = await evaluate(`(() => {
  const canvases = [...document.querySelectorAll('canvas')];
  const nonBlank = canvases.filter((c) => {
    try {
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 40) if (d[i+3] !== 0) return true;
      return false;
    } catch { return 'tainted'; }
  });
  return JSON.stringify({
    loading: !!document.querySelector('.loading'),
    cards: document.querySelectorAll('.card').length,
    canvases: canvases.length,
    nonBlankCanvases: nonBlank.length,
    canvasSizes: canvases.map((c) => c.width + 'x' + c.height),
    stripValues: [...document.querySelectorAll('.strip .v')].map((e) => e.textContent),
    stripSubs: [...document.querySelectorAll('.strip .sub')].map((e) => e.textContent),
    badge: document.querySelector('.badge')?.textContent,
    years: [...document.querySelectorAll('.years button')].map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')),
    cardTitles: [...document.querySelectorAll('.card h2')].map((e) => e.textContent),
    ignoresYears: !!document.querySelector('.ignores-years'),
    watermark: document.querySelector('.watermark')?.textContent,
    issueMonths: document.querySelectorAll('.issue-month').length,
    checks: [...document.querySelectorAll('.checks span')].map((e) => e.textContent),
    firstIssues: [...document.querySelectorAll('.issue-month')].slice(0, 6).map((e) => e.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160)),
    granToggle: [...document.querySelectorAll('.pill')].map((e) => e.textContent),
    docHeight: document.documentElement.scrollHeight,
  }, null, 1);
})()`);

console.log(report);
if (logs.length) console.log('\nCONSOLE:\n' + logs.join('\n'));

await send('Browser.close');
ws.close();
chrome.kill();
process.exit(0);
