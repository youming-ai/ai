// Render-performance probe: real Chrome, real traces, no third-party services.
//
// Usage: node scripts/perf-probe.mjs --url http://127.0.0.1:8787/ [--runs 3]
//        [--cpu 4] [--net slow4g|none] [--label baseline] [--json out.json]
//
// Why a hand-rolled CDP client: Lighthouse would add a large dependency and its
// simulated throttling hides the per-change signal. This measures the same page
// under a fixed budget so a before/after comparison is meaningful, and reports
// the request list so a change in what the browser fetches (not only how fast)
// is visible.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const CHROME =
  arg('chrome', '') ||
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_UNDER_TEST = arg('url', 'http://127.0.0.1:8787/');
const RUNS = Number(arg('runs', '3'));
const CPU = Number(arg('cpu', '4'));
const NET = arg('net', 'slow4g');
const LABEL = arg('label', 'run');
const JSON_OUT = arg('json', '');

const NET_PROFILES = {
  // Lighthouse-ish "Slow 4G": download 1.6 Mbit/s, 150 ms RTT.
  slow4g: {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  },
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

// Installed before any page script: the observers must exist before the first
// paint or LCP/CLS report nothing.
const OBSERVER_SOURCE = `
window.__perf = { lcp: 0, lcpElement: '', cls: 0, longTasks: [], shifts: 0 };
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__perf.lcp = entry.startTime;
      window.__perf.lcpElement = entry.element ? entry.element.tagName + (entry.url ? ' ' + entry.url : '') : (entry.url || '');
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true });
} catch {}
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) { window.__perf.cls += entry.value; window.__perf.shifts += 1; }
    }
  }).observe({ type: 'layout-shift', buffered: true });
} catch {}
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__perf.longTasks.push(Math.round(entry.duration));
  }).observe({ type: 'longtask', buffered: true });
} catch {}
`;

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } else {
        this.events.push(msg);
        const l = this.listeners.get(msg.method);
        if (l) l(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method) {
    return new Promise((resolve) => this.listeners.set(method, resolve));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome devtools endpoint never came up');
}

const PORT = 9222 + Math.floor(Math.random() * 500);
const userDataDir = mkdtempSync(join(tmpdir(), 'perf-probe-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const results = [];
try {
  const version = await waitForDevtools(PORT);
  const browserWs = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => browserWs.addEventListener('open', r));
  const browser = new Cdp(browserWs);

  for (let run = 1; run <= RUNS; run++) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    // Attach so the target is not reaped as an unused tab; the measurement
    // itself talks over the page's own devtools socket below.
    await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const pageWs = new WebSocket(
      version.webSocketDebuggerUrl.replace(/\/devtools\/browser\/.*/, `/devtools/page/${targetId}`),
    );
    await new Promise((r) => pageWs.addEventListener('open', r));
    const page = new Cdp(pageWs);

    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Runtime.enable');
    await page.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.send('Network.emulateNetworkConditions', NET_PROFILES[NET] ?? NET_PROFILES.slow4g);
    await page.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SOURCE });

    const loaded = page.once('Page.loadEventFired');
    const t0 = Date.now();
    await page.send('Page.navigate', { url: URL_UNDER_TEST });
    await loaded;
    const loadMs = Date.now() - t0;
    await sleep(3500); // let late LCP/CLS/long tasks land

    const evaluated = await page.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `JSON.stringify({
        perf: window.__perf,
        nav: (() => { const n = performance.getEntriesByType('navigation')[0] || {}; return {
          ttfb: n.responseStart, domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd, transferSize: n.transferSize }; })(),
        fcp: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0,
        resources: performance.getEntriesByType('resource').map(r => ({ name: r.name, type: r.initiatorType, size: r.transferSize || 0, start: Math.round(r.startTime), dur: Math.round(r.duration), renderBlocking: r.renderBlockingStatus })),
        apiCalls: performance.getEntriesByType('resource').filter(r => r.name.includes('/api/')).map(r => r.name),
        cards: document.querySelectorAll('article').length,
        scripts: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')),
      })`,
    });
    const data = JSON.parse(evaluated.result.value);

    // TBT proxy: time spent in long tasks beyond 50ms, the standard definition.
    const tbt = data.perf.longTasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0);
    const byType = {};
    for (const r of data.resources) byType[r.type] = (byType[r.type] || 0) + r.size;
    const renderBlocking = data.resources.filter((r) => r.renderBlocking === 'blocking');

    results.push({
      run,
      loadMs,
      lcp: Math.round(data.perf.lcp),
      lcpElement: data.perf.lcpElement,
      cls: Number(data.perf.cls.toFixed(4)),
      fcp: Math.round(data.fcp),
      tbt,
      longTasks: data.perf.longTasks.length,
      ttfb: Math.round(data.nav.ttfb || 0),
      domContentLoaded: Math.round(data.nav.domContentLoaded || 0),
      requests: data.resources.length,
      bytes: Object.values(byType).reduce((a, b) => a + b, 0),
      bytesByType: byType,
      renderBlocking: renderBlocking.map(
        (r) => `${r.name.split('/').pop()} (${Math.round(r.dur)}ms)`,
      ),
      apiCalls: data.apiCalls,
      cards: data.cards,
      scripts: data.scripts.length,
    });

    await browser.send('Target.closeTarget', { targetId });
    pageWs.close();
  }
} finally {
  chrome.kill();
  // Chrome is still flushing its profile when it is killed; a failed cleanup
  // must not discard the measurements.
  await sleep(500);
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const summary = {
  label: LABEL,
  url: URL_UNDER_TEST,
  runs: RUNS,
  cpuThrottle: `${CPU}x`,
  network: NET,
  median: {
    lcp: median(results.map((r) => r.lcp)),
    fcp: median(results.map((r) => r.fcp)),
    cls: median(results.map((r) => r.cls)),
    tbt: median(results.map((r) => r.tbt)),
    ttfb: median(results.map((r) => r.ttfb)),
    loadMs: median(results.map((r) => r.loadMs)),
    requests: median(results.map((r) => r.requests)),
    bytes: median(results.map((r) => r.bytes)),
    cards: median(results.map((r) => r.cards)),
  },
  lcpElement: results[0].lcpElement,
  apiCalls: results[0].apiCalls,
  bytesByType: results[0].bytesByType,
  renderBlocking: results[0].renderBlocking,
  perRun: results,
};
console.log(JSON.stringify(summary, null, 2));
if (JSON_OUT) (await import('node:fs')).writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2));
