/**
 * Incremental history builder. Fed every event (replay pre-pass or live), it produces append-only
 * per-bucket series that the views render:
 *   - 1-second buckets: mid min/max/mean + sample count, spread min/max/mean, event counts
 *   - heatmap raster: book liquidity binned by price, sampled at each bucket close
 *   - strategy decisions
 * `drain()` returns everything produced since the previous drain, so replay (one big drain) and
 * live mode (a small drain per frame) share the same code path.
 */
import type { OrderBook } from './orderbook';
import { ImbalanceStrategy, type Decision, type StrategyParams, DEFAULT_PARAMS } from './strategy';

export const BUCKET_MS = 1000;

export interface Grid {
  /** inclusive price range in ticks covered by the raster */
  lo: number;
  hi: number;
  binTicks: number;
  rows: number;
  /** bucket 0 start time (ms) */
  t0: number;
  /** log scale: intensity = log1p(q/q0) / log1p(qmax/q0) */
  q0: number;
  qmax: number;
}

/** Per-bucket stats, struct-of-arrays. NaN where there were no samples. */
export const STAT_FIELDS = [
  'midMin',
  'midMax',
  'midSum',
  'midN',
  'sprMin',
  'sprMax',
  'sprSum',
  'bid',
  'ask',
  'nDepth',
  'nTrade',
  'buyVol',
  'sellVol',
  'gaps',
] as const;
export type StatField = (typeof STAT_FIELDS)[number];
export const NSTAT = STAT_FIELDS.length;
export const S = Object.fromEntries(STAT_FIELDS.map((f, i) => [f, i])) as Record<StatField, number>;

export interface HistoryPatch {
  /** first bucket index in this patch */
  col0: number;
  ncols: number;
  /** ncols * NSTAT, row-major per bucket */
  stats: Float64Array;
  /** ncols * rows each, column-major (col * rows + row), 0..255 */
  bidRaster: Uint8Array;
  askRaster: Uint8Array;
  decisions: Decision[];
}

export function makeGrid(midTicks: number, t0: number, halfRangeTicks: number, maxRows = 2048): Grid {
  const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const span = halfRangeTicks * 2;
  const binTicks = nice.find((b) => span / b <= maxRows) ?? Math.ceil(span / maxRows);
  const lo = Math.floor((midTicks - halfRangeTicks) / binTicks) * binTicks;
  const rows = Math.ceil(span / binTicks) + 1;
  return {
    lo,
    hi: lo + rows * binTicks - 1,
    binTicks,
    rows,
    t0: Math.floor(t0 / BUCKET_MS) * BUCKET_MS,
    q0: 0.01,
    qmax: 50,
  };
}

export class Analyzer {
  readonly strategy: ImbalanceStrategy;
  private cur: Float64Array = new Float64Array(NSTAT);
  private curCol = -1;
  private pendingStats: number[] = [];
  private pendingBid: Uint8Array[] = [];
  private pendingAsk: Uint8Array[] = [];
  private pendingDecisions: Decision[] = [];
  private pendingCol0 = 0;
  private binBid: Float64Array;
  private binAsk: Float64Array;
  private logDen: number;
  decisions: Decision[] = [];

  constructor(
    readonly grid: Grid,
    params: StrategyParams = DEFAULT_PARAMS,
    toPrice: (t: number) => number = (t) => t / 100,
  ) {
    this.strategy = new ImbalanceStrategy(params, toPrice);
    this.binBid = new Float64Array(grid.rows);
    this.binAsk = new Float64Array(grid.rows);
    this.logDen = Math.log1p(grid.qmax / grid.q0);
    this.clearCur();
  }

  colOf(t: number): number {
    return Math.floor((t - this.grid.t0) / BUCKET_MS);
  }

  private clearCur(): void {
    const c = this.cur;
    c.fill(0);
    c[S.midMin] = Infinity;
    c[S.midMax] = -Infinity;
    c[S.sprMin] = Infinity;
    c[S.sprMax] = -Infinity;
    c[S.bid] = NaN;
    c[S.ask] = NaN;
  }

  /**
   * Must be called before processing an event at time t (closes finished buckets using the book
   * state as it was at the end of those buckets).
   */
  tick(t: number, book: OrderBook): void {
    const col = this.colOf(t);
    if (this.curCol === -1) {
      this.curCol = Math.max(0, col);
      this.pendingCol0 = this.curCol;
      return;
    }
    while (this.curCol < col) this.closeBucket(book);
  }

  onDepth(t: number, book: OrderBook): void {
    const c = this.cur;
    c[S.nDepth]!++;
    if (!book.valid) return;
    const b = book.bestBid();
    const a = book.bestAsk();
    if (!Number.isNaN(b) && !Number.isNaN(a)) {
      const mid = (a + b) / 2;
      const spr = a - b;
      if (mid < c[S.midMin]!) c[S.midMin] = mid;
      if (mid > c[S.midMax]!) c[S.midMax] = mid;
      c[S.midSum]! += mid;
      c[S.midN]!++;
      if (spr < c[S.sprMin]!) c[S.sprMin] = spr;
      if (spr > c[S.sprMax]!) c[S.sprMax] = spr;
      c[S.sprSum]! += spr;
      c[S.bid] = b;
      c[S.ask] = a;
    }
    const d = this.strategy.onBook(t, book);
    if (d) {
      this.decisions.push(d);
      this.pendingDecisions.push(d);
    }
  }

  onTrade(buy: boolean, qty: number): void {
    const c = this.cur;
    c[S.nTrade]!++;
    if (buy) c[S.buyVol]! += qty;
    else c[S.sellVol]! += qty;
  }

  onGap(): void {
    this.cur[S.gaps]!++;
  }

  /** Close the current bucket (also used at end of session). */
  closeBucket(book: OrderBook): void {
    const c = this.cur;
    for (let i = 0; i < NSTAT; i++) {
      const v = c[i]!;
      this.pendingStats.push(Number.isFinite(v) ? v : NaN);
    }
    const { rows } = this.grid;
    const bid = new Uint8Array(rows);
    const ask = new Uint8Array(rows);
    if (book.valid) {
      this.binSide(book, true, this.binBid, bid);
      this.binSide(book, false, this.binAsk, ask);
    }
    this.pendingBid.push(bid);
    this.pendingAsk.push(ask);
    this.curCol++;
    this.clearCur();
  }

  private binSide(book: OrderBook, isBid: boolean, acc: Float64Array, out: Uint8Array): void {
    const { lo, hi, binTicks, q0 } = this.grid;
    acc.fill(0);
    const side = isBid ? book.bids : book.asks;
    side.forEach((p, q) => {
      if (isBid ? p < lo : p > hi) return false; // walked out of the raster
      if (p < lo || p > hi) return;
      acc[((p - lo) / binTicks) | 0]! += q;
    });
    for (let r = 0; r < acc.length; r++) {
      const q = acc[r]!;
      if (q > 0) out[r] = Math.max(1, Math.min(255, Math.round((Math.log1p(q / q0) / this.logDen) * 255)));
    }
  }

  get closedCols(): number {
    return this.curCol;
  }

  drain(): HistoryPatch {
    const ncols = this.pendingBid.length;
    const rows = this.grid.rows;
    const bidRaster = new Uint8Array(ncols * rows);
    const askRaster = new Uint8Array(ncols * rows);
    for (let i = 0; i < ncols; i++) {
      bidRaster.set(this.pendingBid[i]!, i * rows);
      askRaster.set(this.pendingAsk[i]!, i * rows);
    }
    const patch: HistoryPatch = {
      col0: this.pendingCol0,
      ncols,
      stats: Float64Array.from(this.pendingStats),
      bidRaster,
      askRaster,
      decisions: this.pendingDecisions,
    };
    this.pendingCol0 += ncols;
    this.pendingStats = [];
    this.pendingBid = [];
    this.pendingAsk = [];
    this.pendingDecisions = [];
    return patch;
  }
}
