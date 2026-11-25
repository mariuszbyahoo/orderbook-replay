/**
 * Live-mode data age, measured: serves dist/, switches the app to Live (Binance), waits for the first
 * snapshot sync, then samples the on-screen data age once per rendered frame for N seconds.
 *
 * Data age (src/ui/freshness.ts) at render time =
 *   (local clock + offset to Binance server time) - exchange timestamp of the newest applied event
 *   + wall time since the worker produced the frame.
 * It therefore includes Binance's 100 ms depth batching, network transit from this machine, the error
 * of the clock-offset estimate (about RTT/2), worker processing and up to one frame. It is NOT render latency.
 *
 *   npm run build && npx tsx scripts/bench-live.ts [--seconds 60] [--headless]
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { serve } from './serve';
import { summarize } from '../src/ui/perf';

const { values } = parseArgs({
  options: {
    seconds: { type: 'string', default: '60' },
    headless: { type: 'boolean', default: false },
    out: { type: 'string', default: 'perf/live.json' },
  },
});
const seconds = Number(values.seconds);

// network context: round-trip time to the Binance REST endpoint from this machine
const rtts: number[] = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  await fetch('https://api.binance.com/api/v3/time');
  rtts.push(performance.now() - t);
}

const srv = await serve('dist', '/p/orderbook-replay/', 4176);
const browser = await chromium.launch({ headless: values.headless });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:4176/p/orderbook-replay/?intro=0');
await page.waitForFunction(() => (window as unknown as { __probe: { ready: boolean } }).__probe.ready);
await page.keyboard.press('l');
await page.waitForFunction(
  () => {
    const p = (window as unknown as { __probe: { frame: { mode: string; valid: boolean } | null } }).__probe;
    return p.frame?.mode === 'live' && p.frame.valid;
  },
  null,
  { timeout: 30_000 },
);
await page.waitForTimeout(3000); // settle
// Concurrent baseline: the same streams measured directly in Node (no browser, no app) during the
// sampling window, so app overhead can be separated from network conditions at that moment.
// offset to Binance server time, midpoint method (same as the app's worker): error about ±RTT/2
const tReq = Date.now();
const st = (await (await fetch('https://api.binance.com/api/v3/time')).json()) as { serverTime: number };
const nodeOffset = st.serverTime - (tReq + Date.now()) / 2;
const nodeAges: number[] = [];
const nodeWs = new WebSocket('wss://stream.binance.com:9443/stream?streams=btcusdt@depth@100ms');
nodeWs.onmessage = (m: MessageEvent<string>) => {
  const { data } = JSON.parse(m.data) as { data: { E: number } };
  nodeAges.push(Date.now() + nodeOffset - data.E);
};

// passed as a string: tsx would otherwise inject a __name helper that does not exist in the page
const samples = (await page.evaluate(`new Promise((resolve) => {
  const p = window.__probe;
  const age = [], wall = [], evAge = [], dt = [];
  let stale = 0, invalid = 0, silent = 0, old = 0, gaps0 = null, gaps = 0, last = 0;
  const t0 = performance.now();
  function tick(ts) {
    const f = p.frame, fr = p.fresh;
    if (last) dt.push(ts - last);
    last = ts;
    const w = performance.timeOrigin + performance.now() - f.sentAt;
    age.push(fr.ageMs); wall.push(w); evAge.push(f.now - f.lastEventT);
    if (gaps0 === null) gaps0 = f.counters.gaps;
    gaps = f.counters.gaps - gaps0;
    if (fr.stale) { stale++; if (!f.valid) invalid++; else if (w > 750) silent++; else old++; }
    if (performance.now() - t0 < ${seconds * 1000}) requestAnimationFrame(tick);
    else resolve({ age, wall, evAge, dt, stale, invalid, silent, old, gaps });
  }
  requestAnimationFrame(tick);
})`)) as {
  age: number[];
  wall: number[];
  evAge: number[];
  dt: number[];
  stale: number;
  invalid: number;
  silent: number;
  old: number;
  gaps: number;
};
nodeWs.close();
const doc = {
  measuredAt: new Date().toISOString(),
  what: 'on-screen data age in live mode, sampled once per rendered frame (see scripts/bench-live.ts header)',
  browser: { name: 'Chromium (Playwright)', version: browser.version(), mode: values.headless ? 'headless' : 'headed' },
  durationS: seconds,
  frames: samples.age.length,
  staleFrames: samples.stale,
  staleBreakdown: { bookInvalid: samples.invalid, noFramesFromWorker: samples.silent, newestEventTooOld: samples.old },
  gapsDuringRun: samples.gaps,
  workerToRenderMs: summarize(Float64Array.from(samples.wall)),
  workerNowMinusLastEventMs: summarize(Float64Array.from(samples.evAge)),
  mainFrameMs: summarize(Float64Array.from(samples.dt)),
  dataAgeMs: summarize(Float64Array.from(samples.age)),
  binanceRestRttMs: summarize(Float64Array.from(rtts)),
  nodeBaselineDepthAgeMs: summarize(Float64Array.from(nodeAges)),
  errors,
};
await writeFile(values.out!, JSON.stringify(doc, null, 2) + '\n');
console.log(JSON.stringify(doc, null, 2));
await browser.close();
srv.close();
