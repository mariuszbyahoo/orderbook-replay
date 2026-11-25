/**
 * Mid-price and spread over the heatmap's time window, aggregated per screen pixel.
 * Every figure is shown with its sample count and limits: the band is min..max of mid within
 * the pixel's buckets, the line is the mean, and the readout states n, min and max.
 */
import { S } from '../engine/analyzer';
import type { History } from '../ui/history';
import { C } from './palette';
import { fitCanvas, fmtNum, fmtTime, type Viewport } from './util';

export interface Agg {
  n: number;
  min: number;
  max: number;
  mean: number;
  sprN: number;
  sprMean: number;
  sprMax: number;
  sprMin: number;
  buckets: number;
}

export function aggregate(h: History, c0: number, c1: number): Agg {
  let n = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let ss = 0;
  let smax = -Infinity;
  let smin = Infinity;
  let buckets = 0;
  for (let c = Math.max(0, c0); c < Math.min(h.ncols, c1); c++) {
    const k = h.stat(c, S.midN);
    if (!(k > 0)) continue;
    buckets++;
    n += k;
    sum += h.stat(c, S.midSum);
    ss += h.stat(c, S.sprSum);
    min = Math.min(min, h.stat(c, S.midMin));
    max = Math.max(max, h.stat(c, S.midMax));
    smax = Math.max(smax, h.stat(c, S.sprMax));
    smin = Math.min(smin, h.stat(c, S.sprMin));
  }
  return {
    n,
    min,
    max,
    mean: n ? sum / n : NaN,
    sprN: n,
    sprMean: n ? ss / n : NaN,
    sprMax: smax,
    sprMin: smin,
    buckets,
  };
}

export class MidChart {
  private ctx: CanvasRenderingContext2D;
  private lastKey = '';
  points = 0;
  hoverX: number | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly readout: HTMLElement,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): void {
    if (fitCanvas(this.canvas)) this.lastKey = '';
  }

  draw(h: History, v: Viewport, now: number, reduced: boolean): void {
    this.points = 0;
    const rev = Math.max(0, Math.min(h.ncols, h.colOf(now)));
    const key = `${v.t0}|${v.t1}|${rev}|${h.version}|${this.canvas.width}|${this.hoverX}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dpr = W / Math.max(1, this.canvas.clientWidth);
    ctx.clearRect(0, 0, W, H);
    const dec = h.instrument.priceDecimals;
    const sc = 10 ** dec;
    const c0 = Math.max(0, h.colOf(v.t0));
    const c1 = Math.min(rev, h.colOf(v.t1) + 1);
    const cols = Math.max(1, Math.ceil(W / dpr)); // one aggregate per CSS pixel
    const msPerPx = (v.t1 - v.t0) / cols;
    const per: Agg[] = [];
    let lo = Infinity;
    let hi = -Infinity;
    let smax = 0;
    for (let px = 0; px < cols; px++) {
      const a = h.colOf(v.t0 + px * msPerPx);
      const b = Math.max(a + 1, h.colOf(v.t0 + (px + 1) * msPerPx));
      const g = aggregate(h, Math.max(a, c0), Math.min(b, c1));
      per.push(g);
      if (g.n) {
        lo = Math.min(lo, g.min);
        hi = Math.max(hi, g.max);
        smax = Math.max(smax, g.sprMax);
      }
    }
    const mH = H * 0.68;
    const sTop = mH + 10 * dpr;
    const sH = H - sTop - 4 * dpr;
    if (!Number.isFinite(lo)) {
      this.readout.textContent = 'No samples in view yet.';
      return;
    }
    const padP = Math.max((hi - lo) * 0.08, 1);
    lo -= padP;
    hi += padP;
    const ym = (p: number): number => mH - ((p - lo) / (hi - lo)) * mH;
    const ys = (s: number): number => sTop + sH - (s / Math.max(smax * 1.6, 1)) * sH; // headroom: a 1-tick spread is not 'full'
    const xp = (px: number): number => px * dpr;

    ctx.fillStyle = 'rgba(240,240,240,0.16)';
    for (let px = 0; px < cols; px++) {
      const g = per[px]!;
      if (!g.n) continue;
      const y0 = ym(g.max);
      ctx.fillRect(xp(px), y0, dpr, Math.max(dpr, ym(g.min) - y0));
      this.points++;
    }
    ctx.strokeStyle = C.mid;
    ctx.lineWidth = 1.25 * dpr;
    ctx.beginPath();
    let pen = false;
    for (let px = 0; px < cols; px++) {
      const g = per[px]!;
      if (!g.n) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(xp(px), ym(g.mean));
      else ctx.moveTo(xp(px), ym(g.mean));
      pen = true;
      this.points++;
    }
    ctx.stroke();
    // spread: mean (line) and max (thin ticks)
    ctx.fillStyle = 'rgba(204,121,167,0.35)';
    ctx.strokeStyle = C.decision;
    ctx.beginPath();
    pen = false;
    for (let px = 0; px < cols; px++) {
      const g = per[px]!;
      if (!g.n) {
        pen = false;
        continue;
      }
      ctx.fillRect(xp(px), ys(g.sprMax), dpr, Math.max(dpr, ys(0) - ys(g.sprMax)));
      if (pen) ctx.lineTo(xp(px), ys(g.sprMean));
      else ctx.moveTo(xp(px), ys(g.sprMean));
      pen = true;
      this.points += 2;
    }
    ctx.stroke();
    ctx.fillStyle = C.dim;
    ctx.font = `${10 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(`mid ${fmtNum(hi / sc, dec)}`, 4 * dpr, 12 * dpr);
    ctx.fillText(`${fmtNum(lo / sc, dec)}`, 4 * dpr, mH - 4 * dpr);
    ctx.fillText(`spread 0 – ${fmtNum(smax / sc, dec)}`, 4 * dpr, sTop + 10 * dpr);
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(0, mH + 5 * dpr);
    ctx.lineTo(W, mH + 5 * dpr);
    ctx.stroke();

    // readout: window, plus hovered pixel
    const win = aggregate(h, c0, c1);
    const f = (x: number): string => fmtNum(x / sc, dec);
    const bucketsPerPx = Math.max(1, msPerPx / 1000);
    let text =
      `Window mid ${f(win.mean)}  n=${win.n.toLocaleString()} updates / ${win.buckets} s  ` +
      `[min ${f(win.min)} · max ${f(win.max)}]  ·  spread mean ${fmtNum(win.sprMean / sc, dec + 2)} ` +
      `[min ${f(win.sprMin)} · max ${f(win.sprMax)}]  ·  1 px ≈ ${bucketsPerPx.toFixed(1)} s`;
    if (this.hoverX !== null) {
      const px = Math.max(0, Math.min(cols - 1, Math.floor(this.hoverX)));
      const g = per[px]!;
      const tt = v.t0 + px * msPerPx;
      text += g.n
        ? `\n@ ${fmtTime(tt)}: mid ${f(g.mean)}  n=${g.n}  [${f(g.min)} – ${f(g.max)}]  spread mean ${fmtNum(g.sprMean / sc, dec + 2)} max ${f(g.sprMax)}`
        : `\n@ ${fmtTime(tt)}: no samples`;
      ctx.strokeStyle = C.dim;
      ctx.beginPath();
      ctx.moveTo(xp(px), 0);
      ctx.lineTo(xp(px), H);
      ctx.stroke();
    }
    void reduced;
    this.readout.textContent = text;
  }
}
