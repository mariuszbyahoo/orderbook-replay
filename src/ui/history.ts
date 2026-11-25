/**
 * Main-thread copy of the append-only history. Rendering reads from here; it never mutates it.
 * The heatmap raster lives in an offscreen canvas (one pixel per bucket x price bin) that is
 * scaled into view with drawImage, so a frame costs one blit regardless of cell count.
 */
import { BUCKET_MS, NSTAT, type Grid } from '../engine/analyzer';
import type { Decision } from '../engine/strategy';
import type { HistoryMsg, InstrumentInfo, ResetMsg } from '../protocol';

class GrowF64 {
  a = new Float64Array(1024);
  n = 0;
  append(src: ArrayLike<number>): void {
    if (this.n + src.length > this.a.length) {
      let cap = this.a.length;
      while (cap < this.n + src.length) cap *= 2;
      const b = new Float64Array(cap);
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
    this.a.set(src, this.n);
    this.n += src.length;
  }
}

export class History {
  mode: 'replay' | 'live' = 'replay';
  grid!: Grid;
  instrument!: InstrumentInfo;
  capacity = 0;
  start = 0;
  end = 0;
  /** number of buckets received */
  ncols = 0;
  stats = new Float64Array(0);
  raster!: OffscreenCanvas;
  private rctx!: OffscreenCanvasRenderingContext2D;
  decisions: Decision[] = [];
  tt = new GrowF64();
  tp = new GrowF64();
  tq = new GrowF64();
  ts = new GrowF64();
  info: Record<string, string | number> = {};
  /** bumps whenever history changes, so views know to redraw */
  version = 0;

  reset(m: ResetMsg): void {
    this.mode = m.mode;
    this.grid = m.grid;
    this.instrument = m.instrument;
    this.capacity = m.capacity;
    this.start = m.start;
    this.end = m.end;
    this.info = m.info;
    this.ncols = 0;
    this.stats = new Float64Array(Math.max(1, m.capacity) * NSTAT).fill(NaN);
    this.raster = new OffscreenCanvas(Math.max(1, m.capacity), m.grid.rows);
    this.rctx = this.raster.getContext('2d')!;
    this.rctx.fillStyle = '#0b0e14';
    this.rctx.fillRect(0, 0, this.raster.width, this.raster.height);
    this.decisions = [];
    this.tt = new GrowF64();
    this.tp = new GrowF64();
    this.tq = new GrowF64();
    this.ts = new GrowF64();
    this.append(m.history);
  }

  append(h: HistoryMsg, end?: number): void {
    if (h.ncols > 0 && h.col0 < this.capacity) {
      const n = Math.min(h.ncols, this.capacity - h.col0);
      this.stats.set(h.stats.subarray(0, n * NSTAT), h.col0 * NSTAT);
      if (h.bitmap) this.rctx.drawImage(h.bitmap, h.col0, 0);
      this.ncols = Math.max(this.ncols, h.col0 + n);
    }
    h.bitmap?.close();
    for (const d of h.decisions) this.decisions.push(d);
    this.tt.append(h.trades.t);
    this.tp.append(h.trades.p);
    this.tq.append(h.trades.q);
    this.ts.append(h.trades.side);
    if (end !== undefined) this.end = Math.max(this.end, end);
    this.version++;
  }

  colTime(c: number): number {
    return this.grid.t0 + c * BUCKET_MS;
  }

  colOf(t: number): number {
    return Math.floor((t - this.grid.t0) / BUCKET_MS);
  }

  stat(c: number, f: number): number {
    return this.stats[c * NSTAT + f]!;
  }

  /** first trade index with time > t */
  tradeUpper(t: number): number {
    const a = this.tt.a;
    let lo = 0;
    let hi = this.tt.n;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (a[m]! <= t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
}
