/**
 * Main thread: render only. Receives coalesced frames + history patches from the engine worker
 * and draws in a single requestAnimationFrame loop. Layers redraw only when their inputs change.
 */
import { D_ENTER_LONG, D_ENTER_SHORT } from './engine/strategy';
import { LADDER_DEPTH, type FrameMsg, type FromWorker, type StepUnit, type ToWorker } from './protocol';
import { Heatmap } from './render/heatmap';
import { Ladder } from './render/ladder';
import { MidChart } from './render/midchart';
import { Timeline } from './render/timeline';
import { fmtDur, fmtNum, fmtTime, type Viewport } from './render/util';
import { History } from './ui/history';
import { Ring, summarize, type Summary } from './ui/perf';
import { freshness, type Fresh } from './ui/freshness';

const $ = <T extends Element = HTMLElement>(id: string): T => document.getElementById(id) as unknown as T;
const absNow = (): number => performance.timeOrigin + performance.now();

const params = new URLSearchParams(location.search);
const BENCH_S = Number(params.get('bench') ?? 0);
const DATA_URL = new URL(params.get('data') ?? 'data/sample.jsonl.gz', document.baseURI).href;
/** data older than this (exchange time) is shown as STALE */
const STALE_MS = Number(params.get('staleMs') ?? 1500);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const worker = new Worker(new URL('./worker/engine.worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker): void => worker.postMessage(m);

const history = new History();
let ready = false;
let frame: FrameMsg | null = null;
let framesReceived = 0;
let framesCoalesced = 0;
let lastFrameWall = 0;

const heat = new Heatmap($('heatBase'), $('heatOver'), $<SVGSVGElement>('heatAxes'));
const ladder = new Ladder($('ladder'));
const mid = new MidChart($('midChart'), $('midReadout'));
const timeline = new Timeline($('timeline'));

// ------------------------------------------------------------------ view state
const view = {
  windowMs: 3 * 60_000,
  halfTicks: 4000, // ±$40 at tick 0.01
  follow: true,
  t1: 0,
  center: NaN,
};
let hudOn = true;

// ------------------------------------------------------------------ perf
const frameDt = new Ring(600);
const renderMs = new Ring(600);
const lagMs = new Ring(600);
const pointsRing = new Ring(600);
const layerMs = {
  base: new Ring(600),
  overlay: new Ring(600),
  axes: new Ring(600),
  ladder: new Ring(600),
  mid: new Ring(600),
  timeline: new Ring(600),
};
const layerSummary = (): Record<string, { p50: number; p95: number }> =>
  Object.fromEntries(
    Object.entries(layerMs).map(([k, r]) => {
      const s = summarize(r.values());
      return [k, { p50: +s.p50.toFixed(2), p95: +s.p95.toFixed(2) }];
    }),
  );
let fpsCount = 0;
let fpsT = performance.now();
let fps = 0;
let lastRaf = 0;
let lastPoints = 0;

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'reset':
      history.reset(m);
      ready = true;
      view.center = NaN;
      view.t1 = m.start;
      $('instrument').textContent =
        `${m.instrument.symbol} · tick ${(10 ** -m.instrument.priceDecimals).toFixed(m.instrument.priceDecimals)} · ${m.mode}`;
      $('ladderNote').textContent = `· ${m.instrument.priceDecimals} price dp · ${m.instrument.qtyDecimals} size dp`;
      renderFoot();
      if (BENCH_S && m.mode === 'replay') startBench();
      break;
    case 'frame':
      framesReceived++;
      if (frame && frame.seq + 1 === m.seq && !frameConsumed) framesCoalesced++;
      frameConsumed = false;
      frame = m;
      lastFrameWall = absNow();
      lagMs.push(lastFrameWall - m.sentAt);
      break;
    case 'patch':
      history.append(m.history, m.end);
      break;
    case 'status': {
      const s = $('status');
      s.textContent = m.text;
      s.classList.toggle('error', !!m.error);
      break;
    }
  }
};
let frameConsumed = true;

send({ type: 'load', url: DATA_URL });

// ------------------------------------------------------------------ freshness
const fresh = (f: FrameMsg | null): Fresh => freshness(f, absNow(), STALE_MS);

// ------------------------------------------------------------------ viewport
function viewport(f: FrameMsg | null): Viewport {
  const now = f?.now ?? history.start;
  if (view.follow) {
    if (reducedMotion.matches) {
      // page instead of scroll: jump when the playhead reaches 90 % of the window
      if (now > view.t1 - view.windowMs * 0.1 || now < view.t1 - view.windowMs) view.t1 = now + view.windowMs * 0.8;
    } else view.t1 = now + view.windowMs * 0.06;
  }
  const t1 = view.t1;
  const bb = f?.ladder[0] ?? NaN;
  const ba = f?.ladder[2 * LADDER_DEPTH] ?? NaN;
  const m = (bb + ba) / 2;
  if (Number.isFinite(m)) {
    if (!Number.isFinite(view.center)) view.center = m;
    else if (view.follow) {
      if (reducedMotion.matches) {
        if (Math.abs(m - view.center) > view.halfTicks * 0.6) view.center = m;
      } else view.center += (m - view.center) * 0.12;
    }
  }
  if (!Number.isFinite(view.center)) view.center = (history.grid.lo + history.grid.hi) / 2;
  return { t0: t1 - view.windowMs, t1, p0: view.center - view.halfTicks, p1: view.center + view.halfTicks };
}

// ------------------------------------------------------------------ render loop
let lastHud = 0;
let lastResize = 0;
function loop(ts: number): void {
  requestAnimationFrame(loop);
  if (lastRaf) frameDt.push(ts - lastRaf);
  lastRaf = ts;
  fpsCount++;
  if (ts - fpsT >= 1000) {
    fps = (fpsCount * 1000) / (ts - fpsT);
    fpsCount = 0;
    fpsT = ts;
  }
  if (!ready) return;
  const t0 = performance.now();
  if (ts - lastResize > 250) {
    heat.resize();
    ladder.resize();
    mid.resize();
    timeline.resize();
    lastResize = ts;
  }
  const f = frame;
  frameConsumed = true;
  const fr = fresh(f);
  document.body.classList.toggle('is-stale', fr.stale);
  const freshEl = $('fresh');
  if (freshEl.textContent !== fr.label) freshEl.textContent = fr.label;
  freshEl.className = `fresh ${fr.cls}`;

  const v = viewport(f);
  const now = f?.now ?? history.start;
  heat.draw(history, f, v, fr.stale);
  const ta = performance.now();
  ladder.draw(f, history.instrument.priceDecimals, history.instrument.qtyDecimals, fr.stale);
  const tb = performance.now();
  mid.draw(history, v, now, reducedMotion.matches);
  const tc = performance.now();
  timeline.draw(history, now, [v.t0, v.t1]);
  const td = performance.now();
  layerMs.base.push(heat.timing.base);
  layerMs.overlay.push(heat.timing.overlay);
  layerMs.axes.push(heat.timing.axes);
  layerMs.ladder.push(tb - ta);
  layerMs.mid.push(tc - tb);
  layerMs.timeline.push(td - tc);
  lastPoints = heat.points + ladder.points + mid.points + timeline.points;
  pointsRing.push(lastPoints);
  renderMs.push(performance.now() - t0);
  bench?.sample(ts);

  if (ts - lastHud > 200) {
    lastHud = ts;
    renderHud(f, fr);
    renderStrategy(f);
    $('clock').textContent = f ? `${fmtTime(now, true)} UTC` : '—';
    const tl = $('timeline');
    const pct = history.end > history.start ? ((now - history.start) / (history.end - history.start)) * 100 : 0;
    tl.setAttribute('aria-valuenow', pct.toFixed(0));
    tl.setAttribute('aria-valuetext', `${fmtTime(now)} UTC`);
    $('bPlay').textContent = f?.playing && f.mode === 'replay' ? 'Pause' : 'Play';
    const live = history.mode === 'live';
    for (const b of document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
      '.buttons button:not(#bHelp), #speed',
    ))
      b.disabled = live;
  }
}
requestAnimationFrame(loop);

const s1 = (s: Summary, d = 1): string => `${s.p50.toFixed(d)} / ${s.p95.toFixed(d)} / ${s.max.toFixed(d)}`;
function renderHud(f: FrameMsg | null, fr: Fresh): void {
  const hud = $('hud');
  hud.hidden = !hudOn;
  if (!hudOn) return;
  const dt = summarize(frameDt.values());
  const rm = summarize(renderMs.values());
  const lg = summarize(lagMs.values());
  const pts = summarize(pointsRing.values());
  hud.textContent =
    `FPS            ${fps.toFixed(0)}\n` +
    `frame ms       ${s1(dt)}   p50/p95/max\n` +
    `render ms      ${s1(rm, 2)}\n` +
    `  layers p95   ${Object.entries(layerSummary())
      .map(([k, v]) => `${k} ${v.p95}`)
      .join(' · ')}\n` +
    `points/frame   ${lastPoints.toLocaleString()}  (p95 ${Math.round(pts.p95).toLocaleString()})\n` +
    `heat cells     ${heat.cellsVisible.toLocaleString()}\n` +
    `trades         ${heat.tradeMode === 'aggregated' ? 'VWAP per px column (LOD)' : 'individual'}\n` +
    `worker→main    ${s1(lg)} ms\n` +
    `frames rx/coal ${framesReceived} / ${framesCoalesced}\n` +
    `events/frame   ${f?.eventsSinceLast ?? 0}\n` +
    `data age       ${fmtDur(fr.ageMs)}\n` +
    `gaps/crossed   ${f?.counters.gaps ?? 0} / ${f?.counters.crossed ?? 0}`;
}

function renderStrategy(f: FrameMsg | null): void {
  if (!f) return;
  const dec = history.instrument.priceDecimals;
  const sc = 10 ** dec;
  const bb = f.ladder[0]!;
  const ba = f.ladder[2 * LADDER_DEPTH]!;
  const midp = (bb + ba) / 2 / sc;
  let entry = NaN;
  let n = 0;
  for (const d of history.decisions) {
    if (d.t > f.now) break;
    n++;
    if (d.kind === D_ENTER_LONG || d.kind === D_ENTER_SHORT) entry = d.price / sc;
  }
  const unreal = f.pos !== 0 && Number.isFinite(midp) ? (midp - entry) * f.pos + 0 : 0;
  const rows: [string, string][] = [
    ['signal I', f.signal.toFixed(3)],
    ['position', f.pos === 0 ? 'flat' : `${f.pos > 0 ? 'long' : 'short'} ${Math.abs(f.pos)}`],
    ['entry', f.pos ? fmtNum(entry, dec) : '—'],
    ['realised PnL', `${fmtNum(f.realized, 4)} USDT`],
    ['unrealised @mid', `${fmtNum(unreal, 4)} USDT`],
    ['decisions so far', `${n} / ${history.decisions.length}`],
  ];
  $('strat').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function renderFoot(): void {
  const i = history.info;
  const parts = [
    `Source: ${history.instrument.source}`,
    i.recordedAt ? `recorded ${new Date(Number(i.recordedAt)).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '',
    i.events ? `${Number(i.events).toLocaleString()} events · parse ${i.parseMs} ms · prepass ${i.prepassMs} ms` : '',
    i.cols ? `heatmap ${i.cols}×${i.rows} = ${(Number(i.cols) * Number(i.rows)).toLocaleString()} cells` : '',
    i.gaps !== undefined ? `gaps ${i.gaps} · crossed ${i.crossed} · decisions ${i.decisions}` : '',
    'Times are exchange timestamps, UTC.',
  ];
  $('foot').textContent = parts.filter(Boolean).join(' · ');
}

// ------------------------------------------------------------------ controls
const speeds = [1, 2, 5, 10, 25, 50, 100];
const speedSel = $<HTMLSelectElement>('speed');
function setSpeed(x: number): void {
  speedSel.value = String(x);
  send({ type: 'speed', x });
}
speedSel.onchange = () => setSpeed(Number(speedSel.value));
function bumpSpeed(d: number): void {
  const i = speeds.indexOf(Number(speedSel.value));
  setSpeed(speeds[Math.max(0, Math.min(speeds.length - 1, i + d))]!);
}
function togglePlay(): void {
  if (frame?.mode === 'live') return;
  send({ type: frame?.playing ? 'pause' : 'play' });
}
const step = (unit: StepUnit, dir: 1 | -1): void => send({ type: 'step', unit, dir });
$('bPlay').onclick = togglePlay;
$('bBack1s').onclick = () => step('1s', -1);
$('bBack100').onclick = () => step('100ms', -1);
$('bBackEv').onclick = () => step('event', -1);
$('bFwdEv').onclick = () => step('event', 1);
$('bFwd100').onclick = () => step('100ms', 1);
$('bFwd1s').onclick = () => step('1s', 1);
const followBox = $<HTMLInputElement>('follow');
function setFollow(on: boolean): void {
  view.follow = on;
  followBox.checked = on;
}
followBox.onchange = () => setFollow(followBox.checked);
const liveBox = $<HTMLInputElement>('live');
function setLive(on: boolean): void {
  liveBox.checked = on;
  ready = false;
  frame = null;
  setFollow(true);
  send({ type: 'live', on });
}
liveBox.onchange = () => setLive(liveBox.checked);
const help = $<HTMLDialogElement>('help');
$('bHelp').onclick = () => help.showModal();
// First visit: show the "What you're looking at" overlay once. Skipped in benchmark mode or with ?intro=0.
// Static dialog, no animation, so prefers-reduced-motion needs nothing extra here.
const INTRO_KEY = 'obr.introSeen';
const introWanted = params.get('intro') !== '0' && !BENCH_S;
let introSeen = false;
try {
  introSeen = localStorage.getItem(INTRO_KEY) === '1';
} catch {
  /* storage blocked: show it every time */
}
if (introWanted && !introSeen) help.showModal();
help.addEventListener('close', () => {
  try {
    localStorage.setItem(INTRO_KEY, '1');
  } catch {
    /* ignore */
  }
});

function zoomTime(f: number): void {
  if (BENCH_S) return; // benchmark viewport is fixed: user input must not change what is measured
  view.windowMs = Math.max(10_000, Math.min(4 * 3600_000, view.windowMs * f));
}
function zoomPrice(f: number): void {
  if (BENCH_S) return;
  view.halfTicks = Math.max(200, Math.min(200_000, view.halfTicks * f));
}

document.addEventListener('keydown', (e) => {
  if (BENCH_S) return; // no user input during a benchmark run
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'SELECT' || tag === 'INPUT') {
    if (e.key !== ' ') return;
  }
  if (help.open) return;
  let handled = true;
  switch (e.key) {
    case ' ':
      togglePlay();
      break;
    case 'ArrowRight':
      step(e.shiftKey ? '1s' : '100ms', 1);
      break;
    case 'ArrowLeft':
      step(e.shiftKey ? '1s' : '100ms', -1);
      break;
    case '.':
      step('event', 1);
      break;
    case ',':
      step('event', -1);
      break;
    case ']':
      bumpSpeed(1);
      break;
    case '[':
      bumpSpeed(-1);
      break;
    case 'Home':
      send({ type: 'seek', t: history.start });
      break;
    case 'End':
      send({ type: 'seek', t: history.end });
      break;
    case '+':
    case '=':
      if (e.shiftKey && e.key === '+') zoomPrice(0.7);
      else zoomTime(0.7);
      break;
    case '-':
    case '_':
      if (e.key === '_') zoomPrice(1.4);
      else zoomTime(1.4);
      break;
    case 'f':
    case 'F':
      setFollow(!view.follow);
      break;
    case 'l':
    case 'L':
      setLive(!liveBox.checked);
      break;
    case 'h':
    case 'H':
      hudOn = !hudOn;
      break;
    case '?':
      help.showModal();
      break;
    default:
      handled = false;
  }
  if (handled) e.preventDefault();
});

// timeline scrub
const tl = $('timeline') as HTMLCanvasElement;
let scrubbing = false;
const scrubTo = (e: PointerEvent): void => {
  const r = tl.getBoundingClientRect();
  send({ type: 'seek', t: timeline.timeAt(history, e.clientX - r.left) });
  setFollow(true);
};
tl.addEventListener('pointerdown', (e) => {
  if (BENCH_S) return;
  if (history.mode === 'live') return;
  scrubbing = true;
  tl.setPointerCapture(e.pointerId);
  scrubTo(e);
});
tl.addEventListener('pointermove', (e) => scrubbing && scrubTo(e));
tl.addEventListener('pointerup', () => (scrubbing = false));

// heatmap: wheel zoom, drag pan
const over = $('heatOver');
over.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    if (e.shiftKey) zoomPrice(f);
    else zoomTime(f);
  },
  { passive: false },
);
let drag: { x: number; y: number; t1: number; c: number } | null = null;
over.addEventListener('pointerdown', (e) => {
  if (BENCH_S) return;
  drag = { x: e.clientX, y: e.clientY, t1: view.t1, c: view.center };
  over.setPointerCapture(e.pointerId);
});
over.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) < 3) return;
  setFollow(false);
  view.t1 = drag.t1 - (dx / over.clientWidth) * view.windowMs;
  view.center = drag.c + (dy / over.clientHeight) * view.halfTicks * 2;
});
over.addEventListener('pointerup', () => (drag = null));
over.addEventListener('dblclick', () => setFollow(true));

const midCanvas = $('midChart');
midCanvas.addEventListener('pointermove', (e) => {
  mid.hoverX = e.clientX - midCanvas.getBoundingClientRect().left;
});
midCanvas.addEventListener('pointerleave', () => (mid.hoverX = null));

// ------------------------------------------------------------------ benchmark mode
interface Bench {
  sample(ts: number): void;
}
let bench: Bench | null = null;
function startBench(): void {
  const dt: number[] = [];
  const rm: number[] = [];
  const pts: number[] = [];
  const lg: number[] = [];
  const cells: number[] = [];
  const evs: number[] = [];
  let tStart = 0;
  let last = 0;
  let viewAtStart = '';
  hudOn = true;
  // wide, fixed viewport so the heatmap blits several hundred thousand cells per frame
  view.windowMs = Number(params.get('benchWindowMin') ?? 15) * 60_000;
  view.halfTicks = Number(params.get('benchHalfTicks') ?? 10_000);
  send({ type: 'seek', t: history.start });
  setSpeed(100);
  send({ type: 'bench', on: true });
  send({ type: 'play' });
  // warm-up 2 s, then measure
  const warm = performance.now() + 2000;
  bench = {
    sample(ts: number): void {
      if (performance.now() < warm) return;
      if (!tStart) {
        viewAtStart = `${view.windowMs}|${view.halfTicks}|${view.follow}`;
        tStart = ts;
        last = ts;
        lagMs.clear();
        return;
      }
      dt.push(ts - last);
      last = ts;
      rm.push(renderMs.values().at(-1) ?? NaN);
      pts.push(lastPoints);
      cells.push(heat.cellsVisible);
      evs.push(frame?.eventsSinceLast ?? 0);
      if (ts - tStart >= BENCH_S * 1000) {
        bench = null;
        lg.push(...lagMs.values());
        const res = {
          durationS: BENCH_S,
          speed: 100,
          frames: dt.length,
          fps: dt.length / BENCH_S,
          frameMs: summarize(Float64Array.from(dt)),
          renderMs: summarize(Float64Array.from(rm)),
          pointsPerFrame: summarize(Float64Array.from(pts)),
          heatCellsPerFrame: summarize(Float64Array.from(cells)),
          workerToMainLagMs: summarize(Float64Array.from(lg)),
          layerMsLast600Frames: layerSummary(),
          eventsPerFrame: summarize(Float64Array.from(evs)),
          framesReceived,
          framesCoalesced,
          viewport: {
            cssW: innerWidth,
            cssH: innerHeight,
            dpr: devicePixelRatio,
            windowMs: view.windowMs,
            halfTicks: view.halfTicks,
          },
          reducedMotion: reducedMotion.matches,
          viewportUnchanged: viewAtStart === `${view.windowMs}|${view.halfTicks}|${view.follow}`,
          userAgent: navigator.userAgent,
          info: history.info,
        };
        (window as unknown as { __bench: unknown }).__bench = res;
        send({ type: 'bench', on: false });
        send({ type: 'pause' });
        $('status').textContent =
          `Benchmark done: ${res.fps.toFixed(1)} fps, frame p95 ${res.frameMs.p95.toFixed(1)} ms`;
      }
    },
  };
}

// expose a tiny read-only probe for automated checks
(window as unknown as { __probe: unknown }).__probe = {
  get frame() {
    return frame;
  },
  get fresh() {
    return fresh(frame);
  },
  /** debug: make the engine worker unresponsive for `ms` (simulates a stalled feed/pipeline) */
  freeze(ms: number) {
    send({ type: 'freeze', ms });
  },
  get ready() {
    return ready;
  },
  get view() {
    return { ...view, reducedMotion: reducedMotion.matches };
  },
  get speed() {
    return Number(speedSel.value);
  },
};
