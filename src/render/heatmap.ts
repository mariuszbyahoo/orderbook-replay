/**
 * Depth heatmap: price (y) x time (x), liquidity intensity per (1 s bucket, price bin).
 * Layers:
 *   base    <canvas>  one scaled drawImage of the raster (only revealed buckets)
 *   overlay <canvas>  spread band, best bid/ask, mid, trades, decisions, playhead, future mask
 *   axes    <svg>     price/time ticks, legend
 * Base and overlay redraw independently; each reports how many primitives it drew.
 */
import { S, type Grid } from '../engine/analyzer';
import { D_ENTER_LONG, D_ENTER_SHORT, D_EXIT_LONG, type Decision } from '../engine/strategy';

/** above this many visible trades, aggregate per pixel column */
const TRADE_LOD = 3000;
import type { FrameMsg } from '../protocol';
import { LADDER_DEPTH } from '../protocol';
import type { History } from '../ui/history';
import { C } from './palette';
import { fitCanvas, fmtNum, fmtTime, hatch, SVG_NS, ticks, timeTicks, type Viewport } from './util';

export class Heatmap {
  private bctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private futurePat: CanvasPattern;
  private lastBaseKey = '';
  private lastAxesKey = '';
  /** primitives drawn in the last frame (cells + vertices + markers) */
  points = 0;
  cellsVisible = 0;
  tradeMode: 'individual' | 'aggregated' = 'individual';
  private aggPQ = new Float64Array(0);
  private aggQ = new Float64Array(0);

  constructor(
    readonly base: HTMLCanvasElement,
    readonly overlay: HTMLCanvasElement,
    readonly axes: SVGSVGElement,
  ) {
    this.bctx = base.getContext('2d', { alpha: false })!;
    this.octx = overlay.getContext('2d')!;
    this.futurePat = hatch(this.octx, 'rgba(255,255,255,0.07)', 8);
  }

  resize(): boolean {
    // the raster is blocky by nature: render it at 1x and let CSS upscale (pixelated); lines stay at full DPR
    const a = fitCanvas(this.base, 1);
    const b = fitCanvas(this.overlay);
    if (a || b) {
      this.lastBaseKey = '';
      this.futurePat = hatch(this.octx, 'rgba(255,255,255,0.07)', 8);
    }
    return a || b;
  }

  /** ms spent per sub-layer in the last frame */
  timing = { base: 0, overlay: 0, axes: 0 };

  draw(h: History, f: FrameMsg | null, v: Viewport, stale: boolean): void {
    this.points = 0;
    const t0 = performance.now();
    this.drawBase(h, f, v);
    const t1 = performance.now();
    this.drawOverlay(h, f, v, stale);
    const t2 = performance.now();
    this.drawAxes(h, v);
    this.timing = { base: t1 - t0, overlay: t2 - t1, axes: performance.now() - t2 };
  }

  private x(v: Viewport, t: number): number {
    return ((t - v.t0) / (v.t1 - v.t0)) * this.overlay.width;
  }
  private y(v: Viewport, p: number): number {
    return ((v.p1 - p) / (v.p1 - v.p0)) * this.overlay.height;
  }

  /** Buckets whose close time <= playhead. A bucket's raster sample is the book at its close. */
  revealed(h: History, now: number): number {
    return Math.max(0, Math.min(h.ncols, h.colOf(now)));
  }

  private drawBase(h: History, f: FrameMsg | null, v: Viewport): void {
    const g = h.grid;
    const now = f?.now ?? h.start;
    const rev = this.revealed(h, now);
    const key = `${v.t0}|${v.t1}|${v.p0}|${v.p1}|${rev}|${h.version}|${this.base.width}x${this.base.height}`;
    if (key === this.lastBaseKey) {
      this.points += 0;
      return;
    }
    this.lastBaseKey = key;
    const ctx = this.bctx;
    const W = this.base.width;
    const H = this.base.height;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    // source rect in raster pixels
    let sx0 = (v.t0 - g.t0) / 1000;
    let sx1 = Math.min(rev, (v.t1 - g.t0) / 1000);
    const yImg = (p: number): number => g.rows - (p - g.lo) / g.binTicks;
    let sy0 = yImg(v.p1);
    let sy1 = yImg(v.p0);
    const dx = (sx: number): number => ((sx - (v.t0 - g.t0) / 1000) / ((v.t1 - v.t0) / 1000)) * W;
    const dy = (sy: number): number => ((sy - yImg(v.p1)) / (yImg(v.p0) - yImg(v.p1))) * H;
    sx0 = Math.max(0, sx0);
    sx1 = Math.min(h.raster.width, sx1);
    sy0 = Math.max(0, sy0);
    sy1 = Math.min(g.rows, sy1);
    if (sx1 > sx0 && sy1 > sy0) {
      ctx.drawImage(h.raster, sx0, sy0, sx1 - sx0, sy1 - sy0, dx(sx0), dy(sy0), dx(sx1) - dx(sx0), dy(sy1) - dy(sy0));
      this.cellsVisible = Math.ceil(sx1 - sx0) * Math.ceil(sy1 - sy0);
      this.points += this.cellsVisible;
    } else this.cellsVisible = 0;
    // raster band limits
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    const top = this.y(v, g.hi);
    const bot = this.y(v, g.lo);
    if (top > 0) ctx.fillRect(0, 0, W, top);
    if (bot < H) ctx.fillRect(0, bot, W, H - bot);
  }

  private drawOverlay(h: History, f: FrameMsg | null, v: Viewport, stale: boolean): void {
    const ctx = this.octx;
    const W = this.overlay.width;
    const H = this.overlay.height;
    const dpr = W / Math.max(1, this.overlay.clientWidth);
    ctx.clearRect(0, 0, W, H);
    const now = f?.now ?? h.start;
    const rev = this.revealed(h, now);
    const c0 = Math.max(0, h.colOf(v.t0));
    const c1 = Math.min(rev, h.colOf(v.t1) + 1);
    const step = Math.max(1, Math.floor((c1 - c0) / (W / 2))); // decimate to ~2 px per vertex

    // spread band + best bid/ask: per-bucket close, then the live book up to the playhead
    const bidPts: number[] = [];
    const askPts: number[] = [];
    for (let c = c0; c < c1; c += step) {
      const b = h.stat(c, S.bid);
      const a = h.stat(c, S.ask);
      const x = this.x(v, h.colTime(c + 1));
      bidPts.push(x, Number.isNaN(b) ? NaN : this.y(v, b));
      askPts.push(x, Number.isNaN(a) ? NaN : this.y(v, a));
    }
    if (f && f.valid) {
      const xb = this.x(v, now);
      bidPts.push(xb, this.y(v, f.ladder[0]!));
      askPts.push(xb, this.y(v, f.ladder[2 * LADDER_DEPTH]!));
    }
    ctx.fillStyle = 'rgba(240,240,240,0.10)';
    ctx.beginPath();
    // segment [x(i-1), x(i)] holds the values sampled at x(i-1), matching the step lines
    for (let i = 2; i < bidPts.length; i += 2) {
      const yb = bidPts[i - 1]!;
      const ya = askPts[i - 1]!;
      if (Number.isNaN(yb) || Number.isNaN(ya)) continue;
      ctx.rect(bidPts[i - 2]!, ya, bidPts[i]! - bidPts[i - 2]!, Math.max(1, yb - ya));
    }
    ctx.fill();
    this.points += this.polyline(ctx, bidPts, C.bid, 1.25 * dpr, []);
    this.points += this.polyline(ctx, askPts, C.ask, 1.25 * dpr, [4 * dpr, 2 * dpr]); // dashed = ask
    // mid
    const midPts: number[] = [];
    for (let i = 0; i < bidPts.length; i += 2) midPts.push(bidPts[i]!, (bidPts[i + 1]! + askPts[i + 1]!) / 2);
    this.points += this.polyline(ctx, midPts, C.mid, 1 * dpr, []);

    // trades: ▲ aggressive buy, ▼ aggressive sell; area ~ size.
    // LOD: above TRADE_LOD visible trades, aggregate per CSS-pixel column and side into one marker at
    // the column's VWAP, sized by summed volume (stated in the legend line below).
    const i0 = h.tradeUpper(v.t0);
    const i1 = h.tradeUpper(Math.min(now, v.t1));
    const n = i1 - i0;
    this.tradeMode = n > TRADE_LOD ? 'aggregated' : 'individual';
    const tri = (x: number, y: number, r: number, up: boolean): void => {
      if (up) {
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y + r * 0.8);
        ctx.lineTo(x - r, y + r * 0.8);
      } else {
        ctx.moveTo(x, y + r);
        ctx.lineTo(x + r, y - r * 0.8);
        ctx.lineTo(x - r, y - r * 0.8);
      }
      ctx.closePath();
    };
    const tt = h.tt.a;
    const tp = h.tp.a;
    const tq = h.tq.a;
    const ts = h.ts.a;
    if (this.tradeMode === 'individual') {
      for (const side of [1, 0]) {
        ctx.beginPath();
        for (let i = i0; i < i1; i++) {
          if (ts[i] !== side) continue;
          const y = this.y(v, tp[i]!);
          if (y < 0 || y > H) continue;
          tri(this.x(v, tt[i]!), y, Math.min(9, 1.5 + Math.sqrt(tq[i]!) * 6) * dpr, side === 1);
          this.points++;
        }
        ctx.fillStyle = side ? 'rgba(86,180,233,0.75)' : 'rgba(230,159,0,0.75)';
        ctx.fill();
      }
    } else {
      const cols = Math.ceil(W / dpr);
      if (this.aggPQ.length < cols * 2) {
        this.aggPQ = new Float64Array(cols * 2);
        this.aggQ = new Float64Array(cols * 2);
      }
      const pq = this.aggPQ;
      const qq = this.aggQ;
      pq.fill(0, 0, cols * 2);
      qq.fill(0, 0, cols * 2);
      const k = cols / (v.t1 - v.t0);
      for (let i = i0; i < i1; i++) {
        const c = Math.floor((tt[i]! - v.t0) * k);
        if (c < 0 || c >= cols) continue;
        const j = c * 2 + ts[i]!;
        pq[j]! += tp[i]! * tq[i]!;
        qq[j]! += tq[i]!;
      }
      for (const side of [1, 0]) {
        ctx.beginPath();
        for (let c = 0; c < cols; c++) {
          const q = qq[c * 2 + side]!;
          if (!q) continue;
          const y = this.y(v, pq[c * 2 + side]! / q);
          if (y < 0 || y > H) continue;
          tri((c + 0.5) * dpr, y, Math.min(7, 1 + Math.sqrt(q) * 3) * dpr, side === 1);
          this.points++;
        }
        ctx.fillStyle = side ? 'rgba(86,180,233,0.8)' : 'rgba(230,159,0,0.8)';
        ctx.fill();
      }
    }

    // decisions (illustrative strategy): batched shapes; labels only when few are visible
    const r = 7 * dpr;
    const shown: Decision[] = [];
    for (const d of h.decisions) {
      if (d.t < v.t0) continue;
      if (d.t > v.t1 || d.t > now) break;
      shown.push(d);
    }
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = C.decision;
    ctx.fillStyle = C.bg;
    ctx.beginPath();
    for (const d of shown) {
      const x = this.x(v, d.t);
      const y = this.y(v, d.price);
      if (d.kind === D_ENTER_LONG || d.kind === D_ENTER_SHORT) tri(x, y, r, d.kind === D_ENTER_LONG);
      else {
        ctx.moveTo(x - r * 0.8, y - r * 0.8);
        ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
      }
      this.points++;
    }
    ctx.fill();
    ctx.stroke();
    if (shown.length <= 60) {
      ctx.fillStyle = C.decision;
      ctx.font = `${11 * dpr}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center';
      for (const d of shown) {
        const label =
          d.kind === D_ENTER_LONG ? 'L' : d.kind === D_ENTER_SHORT ? 'S' : d.kind === D_EXIT_LONG ? 'xL' : 'xS';
        ctx.fillText(label, this.x(v, d.t), this.y(v, d.price) - r - 4 * dpr);
      }
    }

    // future: unknown at the playhead — hatched, not blank
    const xn = this.x(v, now);
    if (xn < W) {
      ctx.fillStyle = this.futurePat;
      ctx.fillRect(Math.max(0, xn), 0, W - Math.max(0, xn), H);
    }
    ctx.strokeStyle = stale ? C.stale : C.mid;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash(stale ? [6 * dpr, 4 * dpr] : []);
    ctx.beginPath();
    ctx.moveTo(xn, 0);
    ctx.lineTo(xn, H);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private polyline(ctx: CanvasRenderingContext2D, pts: number[], color: string, w: number, dash: number[]): number {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let pen = false;
    let n = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const y = pts[i + 1]!;
      if (Number.isNaN(y)) {
        pen = false;
        continue;
      }
      // step line: hold previous level until this bucket's close
      if (pen) ctx.lineTo(pts[i]!, pts[i - 1]!);
      if (pen) ctx.lineTo(pts[i]!, y);
      else ctx.moveTo(pts[i]!, y);
      pen = true;
      n++;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    return n;
  }

  private drawAxes(h: History, v: Viewport): void {
    const w = this.axes.clientWidth;
    const hh = this.axes.clientHeight;
    const g: Grid = h.grid;
    const dec = h.instrument.priceDecimals;
    const pt = ticks(v.p0 / 10 ** dec, v.p1 / 10 ** dec, Math.max(3, hh / 60));
    const tt = timeTicks(v.t0, v.t1, Math.max(3, w / 110));
    const key = `${w}x${hh}|${pt.join()}|${tt.join()}|${Math.round(v.t0 / 50)}|${Math.round(v.p0 / g.binTicks)}`;
    if (key === this.lastAxesKey) return;
    this.lastAxesKey = key;
    const parts: string[] = [];
    const pdp = pt.length > 1 ? Math.max(0, -Math.floor(Math.log10(pt[1]! - pt[0]!))) : 0;
    for (const p of pt) {
      const y = ((v.p1 - p * 10 ** dec) / (v.p1 - v.p0)) * hh;
      parts.push(
        `<line x1="0" x2="${w}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="gl"/>` +
          `<text x="${w - 4}" y="${(y - 3).toFixed(1)}" class="pl">${fmtNum(p, pdp)}</text>`,
      );
    }
    for (const t of tt) {
      const x = ((t - v.t0) / (v.t1 - v.t0)) * w;
      parts.push(
        `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="0" y2="${hh}" class="gl"/>` +
          `<text x="${(x + 3).toFixed(1)}" y="${hh - 4}" class="tl">${fmtTime(t)}</text>`,
      );
    }
    this.axes.innerHTML = parts.join('');
  }
}

export { SVG_NS };
