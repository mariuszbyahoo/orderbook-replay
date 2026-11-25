/**
 * Timeline scrubber: event density (depth + trade events per pixel) across the whole session,
 * gaps marked with a hatched vermillion stripe, current view window and playhead.
 */
import { S } from '../engine/analyzer';
import type { History } from '../ui/history';
import { C } from './palette';
import { fitCanvas, fmtTime, hatch } from './util';

export class Timeline {
  private ctx: CanvasRenderingContext2D;
  private density: HTMLCanvasElement | OffscreenCanvas | null = null;
  private densityKey = '';
  private gapPat: CanvasPattern;
  points = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.gapPat = hatch(this.ctx, C.gap, 5);
  }

  resize(): void {
    if (fitCanvas(this.canvas)) this.densityKey = '';
  }

  span(h: History): [number, number] {
    return [h.start, Math.max(h.end, h.start + 1000)];
  }

  timeAt(h: History, xCss: number): number {
    const [a, b] = this.span(h);
    return a + (xCss / Math.max(1, this.canvas.clientWidth)) * (b - a);
  }

  /** density histogram is static per history version: cache it in an offscreen layer */
  private buildDensity(h: History): void {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const oc = new OffscreenCanvas(W, H);
    const g = oc.getContext('2d')!;
    const [a, b] = this.span(h);
    const bins = new Float64Array(W);
    const gaps = new Uint8Array(W);
    for (let c = 0; c < h.ncols; c++) {
      const x = Math.floor(((h.colTime(c) - a) / (b - a)) * W);
      if (x < 0 || x >= W) continue;
      bins[x]! += (h.stat(c, S.nDepth) || 0) + (h.stat(c, S.nTrade) || 0);
      if (h.stat(c, S.gaps) > 0) gaps[x] = 1;
    }
    let max = 1;
    for (const v of bins) max = Math.max(max, v);
    const top = H * 0.2;
    g.fillStyle = 'rgba(214,218,227,0.35)';
    for (let x = 0; x < W; x++) {
      const v = bins[x]!;
      if (!v) continue;
      const bh = (Math.sqrt(v) / Math.sqrt(max)) * (H - top);
      g.fillRect(x, H - bh, 1, bh);
    }
    g.fillStyle = this.gapPat;
    for (let x = 0; x < W; x++) if (gaps[x]) g.fillRect(x - 1, 0, 3, H);
    this.density = oc;
  }

  draw(h: History, now: number, view: [number, number]): void {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dpr = W / Math.max(1, this.canvas.clientWidth);
    const key = `${h.version}|${W}|${H}|${h.end}`;
    if (key !== this.densityKey) {
      this.buildDensity(h);
      this.densityKey = key;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, W, H);
    if (this.density) ctx.drawImage(this.density, 0, 0);
    const [a, b] = this.span(h);
    const x = (t: number): number => ((t - a) / (b - a)) * W;
    ctx.strokeStyle = C.bid;
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(x(view[0]), 1, Math.max(2, x(view[1]) - x(view[0])), H - 2);
    ctx.fillStyle = C.mid;
    ctx.fillRect(x(now) - dpr, 0, 2 * dpr, H);
    ctx.fillStyle = C.dim;
    ctx.font = `${10 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(`${fmtTime(a)} UTC`, 4 * dpr, 3 * dpr);
    ctx.textAlign = 'right';
    ctx.fillText(`${fmtTime(b)}`, W - 4 * dpr, 3 * dpr);
    this.points = W;
  }
}
