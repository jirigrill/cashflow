/**
 * Drawer probe — finds a real bar's pixel position via the ECharts instance and
 * dispatches the click there, so a miss is told apart from a broken drawer.
 *
 * Run: node drawer-probe.mjs
 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9224;
const { spawn } = await import('node:child_process');

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--user-data-dir=/tmp/cashflow-drawer-profile',
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

const evaluate = async (expression) => {
  const { result } = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    session,
  );
  if (result?.exceptionDetails) return 'EXCEPTION: ' + JSON.stringify(result.exceptionDetails);
  return result?.result?.value;
};

await send(
  'Emulation.setDeviceMetricsOverride',
  { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false },
  session,
);
await send('Page.navigate', { url: 'http://localhost:5173/?years=2025' }, session);
await sleep(3500);



/**
 * For each chart index, click the centre of a real rendered bar and report
 * whether the drawer opens. Catches overlay series that swallow bar clicks.
 */
async function probeChart(i) {
  // Scroll the card into view first — CDP dispatches at viewport coordinates,
  // so a chart below the fold would otherwise be clicked off-screen.
  await evaluate(`(() => {
    const el = document.querySelectorAll('.chart')[${i}];
    if (el) el.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(500);
  // Attach the tap now: each drawer render re-creates the ECharts instances, so
  // a listener from an earlier probe would be stale.
  await evaluate(`(() => {
    window.__lastEv = null;
    const el = document.querySelectorAll('.chart')[${i}];
    const inst = el && window.echarts.getInstanceByDom(el);
    if (inst) inst.on('click', (e) => {
      window.__lastEv = { name: e.name, seriesName: e.seriesName, componentType: e.componentType };
    });
    return true;
  })()`);
  const pos = await evaluate(`(() => {
    const el = document.querySelectorAll('.chart')[${i}];
    if (!el) return JSON.stringify({ error: 'no chart ${i}' });
    const inst = window.echarts.getInstanceByDom(el);
    if (!inst) return JSON.stringify({ error: 'no instance' });
    const zr = inst.getZr();
    const rects = [];
    zr.storage.traverse((sh) => {
      if (sh.type !== 'rect' || !sh.shape) return;
      const { width, height } = sh.shape;
      if (!width || !height || width < 2 || height < 4) return;
      const b = sh.getBoundingRect().clone();
      b.applyTransform(sh.transform || [1, 0, 0, 1, 0, 0]);
      rects.push({ x: b.x, y: b.y, w: b.width, h: b.height });
    });
    // Legend icons are rects too, but they sit outside the grid — restrict to
    // shapes whose centre the grid actually contains.
    const inGrid = (cx, cy) => {
      try { return inst.containPixel({ gridIndex: 0 }, [cx, cy]); } catch { return true; }
    };
    const bars = rects.filter(
      (r) => r.w < 60 && r.h > 4 && inGrid(r.x + r.w / 2, r.y + r.h / 2),
    );
    const r = el.getBoundingClientRect();
    const title = document.querySelectorAll('.card h2')[${i}]?.textContent;
    if (bars.length) {
      bars.sort((a, b) => b.h - a.h);
      const bar = bars[0];
      return JSON.stringify({
        abs: [r.left + bar.x + bar.w / 2, r.top + bar.y + bar.h / 2],
        title, kind: 'bar',
      });
    }
    // Line-only chart: click a rendered data symbol instead of a bar.
    const syms = [];
    zr.storage.traverse((sh) => {
      if (sh.type === 'rect') return;
      const b = sh.getBoundingRect ? sh.getBoundingRect().clone() : null;
      if (!b) return;
      b.applyTransform(sh.transform || [1, 0, 0, 1, 0, 0]);
      // Data symbols are small; lines and axes are long.
      // Axis labels are text shapes of a similar size — only real data symbols
      // (circles/paths) count, and only inside the plot area.
      if (sh.type === 'text' || sh.type === 'tspan') return;
      if (b.width > 0 && b.width < 18 && b.height > 0 && b.height < 18) {
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        if (!inGrid(cx, cy)) return;
        syms.push({ x: cx, y: cy, t: sh.type });
      }
    });
    if (!syms.length) return JSON.stringify({ error: 'no bars and no symbols' });
    return JSON.stringify({
      abs: [r.left + syms[0].x, r.top + syms[0].y],
      title, kind: 'symbol:' + syms[0].t, symbolCount: syms.length,
    });
  })()`);
  const parsed = JSON.parse(pos);
  if (parsed.error) return `chart ${i}: ${parsed.error}`;
  const x = Math.round(parsed.abs[0]);
  const y = Math.round(parsed.abs[1]);
  // zrender needs a mousemove to establish the hovered target before a click.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, session);
  await sleep(150);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, session);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, session);
  await sleep(700);
  // Record what the chart's own click handler saw, so a null rowsFor lookup is
  // distinguishable from a click that never hit-tested.
  const ev = await evaluate(`(() => JSON.stringify(window.__lastEv || null))()`);
  if (ev && ev !== 'null') console.log('    event:', ev);
  const state = await evaluate(`(() => {
    const d = document.querySelector('.drawer');
    if (!d) return JSON.stringify({ drawer: false });
    return JSON.stringify({ drawer: true, title: d.querySelector('h3')?.textContent, rows: d.querySelectorAll('tbody tr').length });
  })()`);
  const st = JSON.parse(state);
  const label = (parsed.title || '').trim();
  return `chart ${i} (${label}) [${parsed.kind}] clicked at ${x},${y} -> ` +
    (st.drawer ? `DRAWER "${st.title}" ${st.rows} rows` : 'NO DRAWER');
}

for (const i of [0, 1, 2, 3, 4]) {
  console.log(await probeChart(i));
  if (i === 0) {
    const { result } = await send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true },
      session,
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync('shots/06-drawer.png', Buffer.from(result.data, 'base64'));
    console.log('    wrote shots/06-drawer.png');
  }
  // Close any open drawer so the next probe starts clean.
  await evaluate(`(() => { const b = document.querySelector('.drawer button, .drawer .drawer-close'); if (b) b.click(); return true; })()`);
  await sleep(400);
}

await send('Browser.close');
ws.close();
chrome.kill();
process.exit(0);
