/// <reference lib="webworker" />
/**
 * Engine worker: owns the data, the replay clock and the live connection.
 * The main thread only renders; it receives coalesced frames (latest state) and append-only
 * history patches.
 */
import { Analyzer, makeGrid, type Grid, type HistoryPatch } from '../engine/analyzer';
import { DepthSync, type DiffEvent } from '../engine/binanceSync';
import { OrderBook, priceScale, type PriceScale } from '../engine/orderbook';
import { prepass, type Prepass } from '../engine/prepass';
import { EV_SNAP, EV_TRADE, loadSession, type Session } from '../engine/session';
import { imbalance } from '../engine/strategy';
import { rasterToRGBA } from '../render/palette';
import {
  LADDER_DEPTH,
  type FrameMsg,
  type FromWorker,
  type HistoryMsg,
  type InstrumentInfo,
  type StepUnit,
  type ToWorker,
  type TradesChunk,
} from '../protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []): void => ctx.postMessage(m, transfer);
const absNow = (): number => performance.timeOrigin + performance.now();

const TICK_MS = 16;
const SYMBOL = 'BTCUSDT';

// ---------------------------------------------------------------- shared helpers

function toBitmap(p: HistoryPatch, rows: number): ImageBitmap | null {
  if (p.ncols === 0) return null;
  const rgba = rasterToRGBA(p.bidRaster, p.askRaster, p.ncols, rows);
  const oc = new OffscreenCanvas(p.ncols, rows);
  oc.getContext('2d')!.putImageData(new ImageData(rgba, p.ncols, rows), 0, 0);
  return oc.transferToImageBitmap();
}

function historyMsg(p: HistoryPatch, rows: number, trades: TradesChunk): [HistoryMsg, Transferable[]] {
  const bitmap = toBitmap(p, rows);
  const msg: HistoryMsg = { col0: p.col0, ncols: p.ncols, stats: p.stats, bitmap, decisions: p.decisions, trades };
  const tr: Transferable[] = [p.stats.buffer, trades.t.buffer, trades.p.buffer, trades.q.buffer, trades.side.buffer];
  if (bitmap) tr.push(bitmap);
  return [msg, tr];
}

function fillLadder(book: OrderBook, out: Float64Array): void {
  const D = LADDER_DEPTH;
  for (let d = 0; d < D; d++) {
    out[d] = book.bids.priceAt(d);
    out[D + d] = book.bids.qtyAt(d);
    out[2 * D + d] = book.asks.priceAt(d);
    out[3 * D + d] = book.asks.qtyAt(d);
  }
}

let seq = 0;
let mode: 'replay' | 'live' = 'replay';

// ---------------------------------------------------------------- replay

interface Replay {
  s: Session;
  /** time of the first snapshot: before it there is no book, so the replay starts here */
  start: number;
  pp: Prepass;
  instrument: InstrumentInfo;
  info: Record<string, string | number>;
}
let rp: Replay | null = null;
let playing = false;
let speed = 10;
let playT = 0;
let lastWall = 0;
let bench = false;
let dirty = true;
let appliedSinceFrame = 0;

function sessionTrades(s: Session): TradesChunk {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.kind[i] === EV_TRADE) n++;
  const c: TradesChunk = {
    t: new Float64Array(n),
    p: new Float64Array(n),
    q: new Float64Array(n),
    side: new Uint8Array(n),
  };
  let j = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.kind[i] !== EV_TRADE) continue;
    const lv = s.lv0[i]!;
    c.t[j] = s.time[i]!;
    c.p[j] = s.lvTicks[lv]!;
    c.q[j] = s.lvQty[lv]!;
    c.side[j] = s.nb[i]! > 0 ? 1 : 0;
    j++;
  }
  return c;
}

function sendReplayReset(): void {
  if (!rp) return;
  const { pp, s } = rp;
  // copy: the cached patch must survive transfer so we can re-send after live mode
  const patch: HistoryPatch = { ...pp.patch, stats: pp.patch.stats.slice() };
  const [history, tr] = historyMsg(patch, pp.grid.rows, sessionTrades(s));
  post(
    {
      type: 'reset',
      mode: 'replay',
      instrument: rp.instrument,
      grid: pp.grid,
      capacity: pp.patch.ncols,
      start: rp.start,
      end: s.endTime,
      history,
      info: rp.info,
    },
    tr,
  );
}

async function load(url: string): Promise<void> {
  post({ type: 'status', text: 'Loading session…' });
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`fetch ${url}: ${res.status}`);
  // Some hosts transparently decode .gz (Content-Encoding); detect gzip magic instead of trusting the name.
  const [a, b] = res.body.tee();
  const ra = a.getReader();
  const head = (await ra.read()).value;
  void ra.cancel(); // only needed the magic bytes; don't let this branch buffer the whole file
  const isGz = !!head && head[0] === 0x1f && head[1] === 0x8b;
  const body = isGz
    ? b
    : b.pipeThrough(new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>); // normalise to gzip so one parser handles both
  const s = await loadSession(body, (n) => post({ type: 'status', text: `Parsing… ${n.toLocaleString()} records` }));
  const parseMs = performance.now() - t0;
  post({ type: 'status', text: 'Building history…' });
  const pp = prepass(s);
  const meta = s.meta;
  const qtyDecimals = meta ? priceScale(meta.stepSize).decimals : 5;
  let firstSnap = 0;
  while (firstSnap < s.length && s.kind[firstSnap] !== EV_SNAP) firstSnap++;
  rp = {
    s,
    start: firstSnap < s.length ? s.time[firstSnap]! : s.startTime,
    pp,
    instrument: {
      symbol: meta?.symbol ?? '?',
      priceDecimals: s.scale.decimals,
      qtyDecimals,
      source: meta?.source ?? 'unknown',
    },
    info: {
      events: s.length,
      levels: s.levelCount,
      parseMs: Math.round(parseMs),
      prepassMs: Math.round(pp.ms),
      checkpoints: pp.engine.checkpointCount,
      gaps: pp.totals.gaps,
      crossed: pp.totals.crossed,
      clamped: s.clamped,
      decisions: pp.patch.decisions.length,
      rows: pp.grid.rows,
      cols: pp.patch.ncols,
      recordedAt: meta?.startedAt ?? 0,
    },
  };
  playT = rp.start;
  pp.engine.seek(playT);
  sendReplayReset();
  dirty = true;
  post({ type: 'status', text: '' });
}

function replayFrame(): void {
  if (!rp) return;
  const e = rp.pp.engine;
  const now = absNow();
  if (playing) {
    playT += (now - lastWall) * speed;
    if (playT >= rp.s.endTime) {
      if (bench) {
        playT = rp.start;
        e.seek(playT);
      } else {
        playT = rp.s.endTime;
        playing = false;
      }
    }
    appliedSinceFrame += e.advanceTo(playT);
    dirty = true;
  }
  lastWall = now;
  if (!dirty) return;
  dirty = false;
  // strategy state at playhead from the precomputed decision list
  const ds = rp.pp.patch.decisions;
  let lo = 0;
  let hi = ds.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (ds[m]!.t <= playT) lo = m + 1;
    else hi = m;
  }
  const last = lo > 0 ? ds[lo - 1]! : null;
  const ladder = new Float64Array(LADDER_DEPTH * 4);
  fillLadder(e.book, ladder);
  const f: FrameMsg = {
    type: 'frame',
    seq: seq++,
    sentAt: absNow(),
    mode: 'replay',
    playing,
    speed,
    now: playT,
    lastEventT: e.time,
    cursor: e.cursor,
    total: rp.s.length,
    valid: e.book.valid,
    inGap: e.inGap,
    link: 'n/a',
    ladder,
    eventsSinceLast: appliedSinceFrame,
    pos: last?.pos ?? 0,
    realized: last?.realized ?? 0,
    signal: e.book.valid ? imbalance(e.book, 5) : 0,
    counters: { gaps: e.counters.gaps, crossed: e.counters.crossed, stale: e.counters.stale },
  };
  appliedSinceFrame = 0;
  post(f, [ladder.buffer]);
}

function step(unit: StepUnit, dir: 1 | -1): void {
  if (!rp) return;
  const e = rp.pp.engine;
  playing = false;
  if (unit === 'event') {
    e.seekCursor(e.cursor + dir);
    playT = e.time;
  } else {
    const d = unit === '1s' ? 1000 : 100;
    playT = Math.max(rp.start, Math.min(rp.s.endTime, playT + d * dir));
    e.seek(playT);
  }
  dirty = true;
}

// ---------------------------------------------------------------- live

interface Live {
  ws: WebSocket | null;
  sync: DepthSync;
  book: OrderBook;
  scale: PriceScale;
  an: Analyzer | null;
  grid: Grid | null;
  offset: number;
  lastE: number;
  link: 'ok' | 'connecting' | 'down';
  trades: { t: number[]; p: number[]; q: number[]; side: number[] };
  gaps: number;
  crossed: number;
  applied: number;
  timers: number[];
  snapBusy: boolean;
  closed: boolean;
  started: number;
  lastMsgWall: number;
}
let lv: Live | null = null;
const LIVE_CAPACITY = 7200; // buckets = 2 h

async function liveStart(): Promise<void> {
  liveStop();
  mode = 'live';
  playing = false;
  post({ type: 'status', text: 'Connecting to Binance…' });
  let tickSize = '0.01';
  let stepSize = '0.00001';
  let offset = 0;
  try {
    const t0 = Date.now();
    const st = (await (await fetch('https://api.binance.com/api/v3/time')).json()) as { serverTime: number };
    offset = st.serverTime - (t0 + Date.now()) / 2;
    const info = (await (await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${SYMBOL}`)).json()) as {
      symbols: { filters: { filterType: string; tickSize?: string; stepSize?: string }[] }[];
    };
    const fl = info.symbols[0]!.filters;
    tickSize = fl.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize ?? tickSize;
    stepSize = fl.find((f) => f.filterType === 'LOT_SIZE')?.stepSize ?? stepSize;
  } catch (err) {
    post({ type: 'status', text: `Binance REST unreachable: ${String(err)}`, error: true });
  }
  const scale = priceScale(tickSize);
  lv = {
    ws: null,
    sync: new DepthSync(),
    book: new OrderBook(scale),
    scale,
    an: null,
    grid: null,
    offset,
    lastE: 0,
    link: 'connecting',
    trades: { t: [], p: [], q: [], side: [] },
    gaps: 0,
    crossed: 0,
    applied: 0,
    timers: [],
    snapBusy: false,
    closed: false,
    started: Date.now() + offset,
    lastMsgWall: Date.now(),
  };
  const L = lv;
  const instrument: InstrumentInfo = {
    symbol: SYMBOL,
    priceDecimals: scale.decimals,
    qtyDecimals: priceScale(stepSize).decimals,
    source: 'Binance spot public WebSocket (live)',
  };
  connectLive(L, instrument);
  L.timers.push(setInterval(() => liveFrame(L), TICK_MS) as unknown as number);
  L.timers.push(setInterval(() => livePatch(L), 250) as unknown as number);
  // watchdog: a socket can die without a close event; depth@100ms is never silent for 10 s
  L.timers.push(
    setInterval(() => {
      if (L.closed || Date.now() - L.lastMsgWall < 10_000) return;
      L.lastMsgWall = Date.now();
      L.ws?.close(); // onclose -> mark gap + reconnect
      if (L.ws) L.ws.onclose?.(new CloseEvent('close', { code: 4000, reason: 'watchdog' }));
    }, 2000) as unknown as number,
  );
}

function connectLive(L: Live, instrument: InstrumentInfo): void {
  const sym = SYMBOL.toLowerCase();
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${sym}@depth@100ms/${sym}@trade`);
  L.ws = ws;
  L.link = 'connecting';
  ws.onopen = () => {
    L.link = 'ok';
    post({ type: 'status', text: '' });
  };
  ws.onmessage = (m: MessageEvent<string>) => {
    if (L.ws !== ws) return;
    L.lastMsgWall = Date.now();
    const { stream, data } = JSON.parse(m.data) as { stream: string; data: Record<string, unknown> };
    if (stream.endsWith('@trade')) {
      const T = data.T as number;
      L.lastE = Math.max(L.lastE, T);
      const buy = !(data.m as boolean);
      const q = Number(data.q);
      L.an?.tick(T, L.book);
      L.an?.onTrade(buy, q);
      L.trades.t.push(T);
      L.trades.p.push(L.scale.toTicks(data.p as string));
      L.trades.q.push(q);
      L.trades.side.push(buy ? 1 : 0);
      return;
    }
    const ev = data as unknown as DiffEvent;
    L.lastE = Math.max(L.lastE, ev.E);
    const r = L.sync.onDiff({ E: ev.E, U: ev.U, u: ev.u, b: ev.b, a: ev.a });
    if (r.kind === 'applied') applyLive(L, r.ev);
    else if (r.kind === 'gap') {
      L.gaps++;
      L.book.valid = false;
      L.an?.onGap();
      void liveSnapshot(L, instrument);
    } else if (r.kind === 'buffered') void liveSnapshot(L, instrument);
  };
  ws.onclose = () => {
    if (L.closed || L.ws !== ws) return;
    L.ws = null; // fire once per socket (close event and watchdog can both arrive)
    L.link = 'down';
    L.book.valid = false;
    L.sync.reset();
    L.gaps++;
    L.an?.onGap();
    setTimeout(() => !L.closed && connectLive(L, instrument), 2000);
  };
}

function applyLive(L: Live, ev: DiffEvent): void {
  L.an?.tick(ev.E, L.book);
  L.book.applyDiff(ev.U, ev.u, ev.b, ev.a);
  L.applied++;
  if (L.book.isCrossed()) L.crossed++;
  L.an?.onDepth(ev.E, L.book);
}

async function liveSnapshot(L: Live, instrument: InstrumentInfo): Promise<void> {
  if (L.snapBusy || L.sync.synced || !L.sync.wantsSnapshot) return;
  L.snapBusy = true;
  try {
    while (!L.closed && !L.sync.synced) {
      const raw = (await (await fetch(`https://api.binance.com/api/v3/depth?symbol=${SYMBOL}&limit=5000`)).json()) as {
        lastUpdateId: number;
        bids: [string, string][];
        asks: [string, string][];
      };
      const r = L.sync.onSnapshot(raw);
      if (r.kind === 'retry') {
        await new Promise((res) => setTimeout(res, 300));
        continue;
      }
      L.book.loadSnapshot(raw.lastUpdateId, raw.bids, raw.asks);
      if (!L.an) {
        const mid = (L.book.bestBid() + L.book.bestAsk()) / 2;
        const t = L.lastE || Date.now() + L.offset;
        L.grid = makeGrid(mid, t, Math.round(mid * 0.004));
        L.an = new Analyzer(L.grid, undefined, L.scale.toPrice);
        L.an.tick(t, L.book);
        post({
          type: 'reset',
          mode: 'live',
          instrument,
          grid: L.grid,
          capacity: LIVE_CAPACITY,
          start: L.grid.t0,
          end: L.grid.t0,
          history: historyMsg(L.an.drain(), L.grid.rows, emptyTrades())[0],
          info: { source: 'live' },
        });
      }
      for (const ev of r.applied) applyLive(L, ev);
    }
  } catch (err) {
    post({ type: 'status', text: `Snapshot failed: ${String(err)}`, error: true });
    setTimeout(() => void liveSnapshot(L, instrument), 2000);
  } finally {
    L.snapBusy = false;
  }
}

function emptyTrades(): TradesChunk {
  return { t: new Float64Array(0), p: new Float64Array(0), q: new Float64Array(0), side: new Uint8Array(0) };
}

function livePatch(L: Live): void {
  if (!L.an || !L.grid) return;
  if (L.an.closedCols >= LIVE_CAPACITY) return; // buffer full: frames continue, history stops
  const p = L.an.drain();
  const tr = L.trades;
  const trades: TradesChunk = {
    t: Float64Array.from(tr.t),
    p: Float64Array.from(tr.p),
    q: Float64Array.from(tr.q),
    side: Uint8Array.from(tr.side),
  };
  L.trades = { t: [], p: [], q: [], side: [] };
  if (p.ncols === 0 && p.decisions.length === 0 && trades.t.length === 0) return;
  const [history, transfer] = historyMsg(p, L.grid.rows, trades);
  post({ type: 'patch', end: L.lastE, history }, transfer);
}

function liveFrame(L: Live): void {
  const ladder = new Float64Array(LADDER_DEPTH * 4);
  fillLadder(L.book, ladder);
  const st = L.an?.strategy;
  const f: FrameMsg = {
    type: 'frame',
    seq: seq++,
    sentAt: absNow(),
    mode: 'live',
    playing: true,
    speed: 1,
    now: Date.now() + L.offset,
    lastEventT: L.lastE,
    cursor: L.applied,
    total: L.applied,
    valid: L.book.valid,
    inGap: !L.book.valid,
    link: L.link,
    ladder,
    eventsSinceLast: L.applied - liveAppliedAtLastFrame,
    pos: st?.pos ?? 0,
    realized: st?.realized ?? 0,
    signal: L.book.valid ? imbalance(L.book, 5) : 0,
    counters: { gaps: L.gaps, crossed: L.crossed, stale: 0 },
  };
  liveAppliedAtLastFrame = L.applied;
  post(f, [ladder.buffer]);
}
let liveAppliedAtLastFrame = 0;

function liveStop(): void {
  if (!lv) return;
  lv.closed = true;
  lv.ws?.close();
  for (const t of lv.timers) clearInterval(t);
  lv = null;
}

// ---------------------------------------------------------------- dispatch

setInterval(() => {
  if (mode === 'replay') replayFrame();
}, TICK_MS);

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'load':
      load(m.url).catch((err: unknown) => post({ type: 'status', text: `Load failed: ${String(err)}`, error: true }));
      break;
    case 'play':
      if (rp && playT >= rp.s.endTime) {
        playT = rp.start;
        rp.pp.engine.seek(playT);
      }
      playing = true;
      lastWall = absNow();
      dirty = true;
      break;
    case 'pause':
      playing = false;
      dirty = true;
      break;
    case 'speed':
      speed = Math.max(0.1, Math.min(100, m.x));
      dirty = true;
      break;
    case 'step':
      step(m.unit, m.dir);
      break;
    case 'seek':
      if (rp) {
        playT = Math.max(rp.start, Math.min(rp.s.endTime, m.t));
        rp.pp.engine.seek(playT);
        dirty = true;
      }
      break;
    case 'bench':
      bench = m.on;
      break;
    case 'freeze': {
      // debug only: block this thread to simulate a stalled pipeline
      const until = performance.now() + Math.min(m.ms, 10_000);
      while (performance.now() < until) {
        /* spin */
      }
      break;
    }
    case 'live':
      if (m.on) void liveStart();
      else {
        liveStop();
        mode = 'replay';
        sendReplayReset();
        dirty = true;
      }
      break;
  }
};
