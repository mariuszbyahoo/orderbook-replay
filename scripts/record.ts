/**
 * Records a Binance spot BTCUSDT session: REST depth snapshot + depth diff stream @100ms + trades,
 * synchronised per Binance's documented procedure (see src/engine/binanceSync.ts).
 *
 *   npm run record -- --minutes 45 --out data/session.jsonl.gz
 *
 * Only events that passed the sync check are written as `depth`. A detected gap writes a `gap`
 * record followed by a fresh `snap`, so the replay can rebuild the book from scratch at that point.
 */
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { parseArgs } from 'node:util';
import { DepthSync, type DiffEvent, type Snapshot } from '../src/engine/binanceSync';
import type { Rec } from '../src/engine/format';

const { values } = parseArgs({
  options: {
    minutes: { type: 'string', default: '45' },
    out: { type: 'string', default: 'data/session.jsonl.gz' },
    symbol: { type: 'string', default: 'BTCUSDT' },
  },
});
const SYMBOL = values.symbol!.toUpperCase();
const sym = SYMBOL.toLowerCase();
const DURATION_MS = Number(values.minutes) * 60_000;
const REST = 'https://api.binance.com';
const WS = `wss://stream.binance.com:9443/stream?streams=${sym}@depth@100ms/${sym}@trade`;

const gz = createGzip({ level: 6 });
const file = createWriteStream(values.out!);
gz.pipe(file);
const write = (r: Rec): void => {
  gz.write(JSON.stringify(r) + '\n');
};

const stats = { depth: 0, trades: 0, ignored: 0, gaps: 0, snapshots: 0, retries: 0, reconnects: 0 };
const log = (...a: unknown[]): void => console.error(new Date().toISOString(), ...a);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

interface Filter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
}
const info = await getJson<{ symbols: { filters: Filter[] }[] }>(`${REST}/api/v3/exchangeInfo?symbol=${SYMBOL}`);
const filters = info.symbols[0]!.filters;
const tickSize = filters.find((f) => f.filterType === 'PRICE_FILTER')!.tickSize!;
const stepSize = filters.find((f) => f.filterType === 'LOT_SIZE')!.stepSize!;
const startedAt = Date.now();
write({
  k: 'meta',
  symbol: SYMBOL,
  tickSize,
  stepSize,
  source: 'Binance spot public WebSocket (depth@100ms, trade) + REST /api/v3/depth?limit=5000',
  startedAt,
});
log(`recording ${SYMBOL} for ${values.minutes} min -> ${values.out} (tick ${tickSize})`);

const sync = new DepthSync();
let snapshotInFlight = false;
let lastU = -1;
let ws: WebSocket | null = null;
let stopping = false;

async function snapshotLoop(): Promise<void> {
  if (snapshotInFlight) return;
  snapshotInFlight = true;
  try {
    for (let attempt = 0; !sync.synced && !stopping; attempt++) {
      if (!sync.wantsSnapshot) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const t = Date.now();
      const raw = await getJson<{ lastUpdateId: number; bids: [string, string][]; asks: [string, string][] }>(
        `${REST}/api/v3/depth?symbol=${SYMBOL}&limit=5000`,
      );
      const snap: Snapshot = { lastUpdateId: raw.lastUpdateId, bids: raw.bids, asks: raw.asks };
      const r = sync.onSnapshot(snap);
      if (r.kind === 'retry') {
        stats.retries++;
        log(`snapshot retry: ${r.reason}`);
        await new Promise((res) => setTimeout(res, 250 * Math.min(attempt + 1, 8)));
        continue;
      }
      stats.snapshots++;
      // REST snapshot has no timestamp: approximate exchange time with the first applied diff's E.
      const E = r.applied[0]?.E ?? t;
      write({ k: 'snap', t, E, id: snap.lastUpdateId, b: snap.bids, a: snap.asks });
      for (const ev of r.applied) writeDepth(ev, t);
      log(`synced at lastUpdateId=${snap.lastUpdateId}, replayed ${r.applied.length} buffered events`);
    }
  } catch (e) {
    log('snapshot error', e);
    setTimeout(() => void snapshotLoop(), 1000);
  } finally {
    snapshotInFlight = false;
  }
}

function writeDepth(ev: DiffEvent, t: number): void {
  if (lastU !== -1 && ev.U !== lastU + 1) log(`continuity note: U=${ev.U} prev u=${lastU}`);
  lastU = ev.u;
  stats.depth++;
  write({ k: 'depth', t, E: ev.E, U: ev.U, u: ev.u, b: ev.b, a: ev.a });
}

function gap(reason: string): void {
  stats.gaps++;
  lastU = -1;
  log(`GAP: ${reason}`);
  write({ k: 'gap', t: Date.now(), reason });
}

let generation = 0;
let lastMsgAt = Date.now();

/** Reconnect exactly once per socket, whichever of close/error/watchdog fires first. */
function reconnect(gen: number, why: string): void {
  if (stopping || gen !== generation) return;
  generation++;
  stats.reconnects++;
  gap(`${why}; reconnecting`);
  sync.reset();
  try {
    ws?.close();
  } catch {
    /* already closed */
  }
  setTimeout(connect, 1000);
}

function connect(): void {
  const gen = generation;
  lastMsgAt = Date.now();
  ws = new WebSocket(WS);
  ws.onopen = () => log('ws open');
  ws.onmessage = (msg: MessageEvent<string>) => {
    if (gen !== generation) return;
    lastMsgAt = Date.now();
    const t = lastMsgAt;
    const { stream, data } = JSON.parse(msg.data) as { stream: string; data: Record<string, unknown> };
    if (stream.endsWith('@trade')) {
      stats.trades++;
      write({
        k: 'trade',
        t,
        E: data.E as number,
        T: data.T as number,
        id: data.t as number,
        p: data.p as string,
        q: data.q as string,
        m: data.m as boolean,
      });
      return;
    }
    const ev = data as unknown as DiffEvent;
    const r = sync.onDiff({ E: ev.E, U: ev.U, u: ev.u, b: ev.b, a: ev.a });
    if (r.kind === 'applied') writeDepth(r.ev, t);
    else if (r.kind === 'ignored') stats.ignored++;
    else if (r.kind === 'gap') {
      gap(`U=${r.U} > bookId+1=${r.bookId + 1}`);
      void snapshotLoop();
    } else if (!sync.synced) void snapshotLoop();
  };
  ws.onclose = (e) => reconnect(gen, `ws closed code=${e.code}`);
  ws.onerror = () => {
    log('ws error');
    reconnect(gen, 'ws error');
  };
}

// Watchdog: depth@100ms never goes quiet for 10 s on BTCUSDT; silence means a dead socket.
const watchdog = setInterval(() => {
  if (Date.now() - lastMsgAt > 10_000) reconnect(generation, 'no messages for 10 s (watchdog)');
}, 2000);

connect();

const progress = setInterval(() => {
  const mins = ((Date.now() - startedAt) / 60_000).toFixed(1);
  log(`${mins} min`, JSON.stringify(stats));
}, 60_000);

function stop(): void {
  if (stopping) return;
  stopping = true;
  clearInterval(progress);
  clearInterval(watchdog);
  ws?.close();
  log('final', JSON.stringify(stats));
  gz.end();
  file.on('close', () => process.exit(0));
}
setTimeout(stop, DURATION_MS);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
