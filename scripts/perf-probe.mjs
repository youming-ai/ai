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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
/** Max scroll-to-bottom steps; 0 disables the long-board phase. */
const SCROLL_STEPS = Number(arg('scroll', '0'));
/** Stop scrolling once the board holds this many cards, so two configurations
 *  are compared at the same DOM size. */
const SCROLL_UNTIL = Number(arg('scroll-until', '130'));
/** CSS appended to <head> before first paint, for A/B-ing a rendering change on
 *  one build instead of two — used to disable `content-visibility` in the
 *  control arm, so the bundle, the corpus and the machine are all identical. */
const OVERRIDE_CSS = arg('override-css', '');
/** PNG path: capture the viewport after the page settles (and after the scroll
 *  phase, if any). A change to layout has to be *looked at*, not only measured —
 *  this is what makes that possible from here. */
const SCREENSHOT = arg('screenshot', '');
/** `WxH`, e.g. 390x844 for a phone. */
const VIEWPORT = arg('viewport', '1440x900');
/** Run this JS after settling, before measuring and capturing — how a test
 *  drives something the URL cannot (a client-state toggle, for instance). */
const POST_EVAL = arg('eval', '');
/** Capture the whole document rather than the viewport. */
const FULL_PAGE = args.includes('--full-page');

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
    const [viewW, viewH] = VIEWPORT.split('x').map(Number);
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: Number.isFinite(viewW) ? viewW : 1440,
      height: Number.isFinite(viewH) ? viewH : 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SOURCE });
    if (OVERRIDE_CSS) {
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `document.addEventListener('DOMContentLoaded', () => {
          const style = document.createElement('style');
          style.textContent = ${JSON.stringify(OVERRIDE_CSS)};
          document.head.appendChild(style);
        });`,
      });
    }

    const loaded = page.once('Page.loadEventFired');
    const t0 = Date.now();
    await page.send('Page.navigate', { url: URL_UNDER_TEST });
    await loaded;
    const loadMs = Date.now() - t0;
    await sleep(3500); // let late LCP/CLS/long tasks land

    // Optional: grow the board by scrolling, and measure what that costs.
    // LCP/CLS cannot show this — they are first-paint metrics — so the report
    // is the delta in the browser's own layout/style/script counters across the
    // scroll phase, which is exactly what `content-visibility` is supposed to
    // reduce for the cards that are off screen.
    let scrollCost = null;
    if (SCROLL_STEPS > 0) {
      await page.send('Performance.enable');
      const readCounters = async () => {
        const { metrics } = await page.send('Performance.getMetrics');
        const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
        return {
          layout: get('LayoutDuration'),
          style: get('RecalcStyleDuration'),
          script: get('ScriptDuration'),
          task: get('TaskDuration'),
          layoutCount: get('LayoutCount'),
          nodes: get('Nodes'),
        };
      };
      const before = await readCounters();
      // Wait until the board actually holds SCROLL_UNTIL cards, rather than for
      // a fixed time. A fixed wait let the two configurations append different
      // numbers of rows (106 against 82), which made the counters incomparable —
      // fewer cards is less work, and it looked like an improvement that was
      // partly just a smaller DOM.
      const countCards = async () =>
        (
          await page.send('Runtime.evaluate', {
            returnByValue: true,
            expression: 'document.querySelectorAll("article").length',
          })
        ).result.value;
      let steps = 0;
      for (; steps < SCROLL_STEPS; steps++) {
        if ((await countCards()) >= SCROLL_UNTIL) break;
        const seen = await countCards();
        await page.send('Runtime.evaluate', {
          expression: 'window.scrollTo(0, document.body.scrollHeight)',
        });
        // One appended page per step: wait for the count to move, with a cap so a
        // stalled fetch cannot hang the measurement.
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          await sleep(150);
          if ((await countCards()) > seen) break;
        }
      }
      const after = await readCounters();
      const cards = await countCards();
      scrollCost = {
        steps,
        cards,
        target: SCROLL_UNTIL,
        layoutMs: Math.round((after.layout - before.layout) * 1000),
        styleMs: Math.round((after.style - before.style) * 1000),
        scriptMs: Math.round((after.script - before.script) * 1000),
        taskMs: Math.round((after.task - before.task) * 1000),
        layouts: after.layoutCount - before.layoutCount,
        nodes: after.nodes - before.nodes,
      };
    }

    if (POST_EVAL) {
      await page.send('Runtime.evaluate', { expression: POST_EVAL });
      await sleep(600);
    }

    if (SCREENSHOT && run === RUNS) {
      const shot = await page.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: FULL_PAGE,
      });
      writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }

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
        height: document.documentElement.scrollHeight,
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
      scrollCost,
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
      height: data.height,
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
    height: median(results.map((r) => r.height)),
  },
  lcpElement: results[0].lcpElement,
  apiCalls: results[0].apiCalls,
  bytesByType: results[0].bytesByType,
  renderBlocking: results[0].renderBlocking,
  scroll:
    SCROLL_STEPS > 0
      ? {
          steps: SCROLL_STEPS,
          targetCards: SCROLL_UNTIL,
          medianLayoutMs: median(results.map((r) => r.scrollCost.layoutMs)),
          medianStyleMs: median(results.map((r) => r.scrollCost.styleMs)),
          medianScriptMs: median(results.map((r) => r.scrollCost.scriptMs)),
          medianTaskMs: median(results.map((r) => r.scrollCost.taskMs)),
          medianLayouts: median(results.map((r) => r.scrollCost.layouts)),
          cards: median(results.map((r) => r.scrollCost.cards)),
        }
      : null,
  perRun: results,
};
console.log(JSON.stringify(summary, null, 2));
if (JSON_OUT) (await import('node:fs')).writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2));
