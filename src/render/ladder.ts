/**
 * Price ladder (current book). Canvas, monospace tabular figures, fixed decimals from the
 * instrument's tick/step size, right-aligned columns => decimal points line up.
 * Bids: solid bars + "B" marker. Asks: hatched bars + "A" marker. Readable without colour.
 */
import { LADDER_DEPTH, type FrameMsg } from '../protocol';
import { C } from './palette';
import { fitCanvas, fmtNum, hatch } from './util';

export class Ladder {
  private ctx: CanvasRenderingContext2D;
  private askPat: CanvasPattern;
  private lastSeq = -1;
  private lastStale = false;
  points = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.askPat = hatch(this.ctx, 'rgba(230,159,0,0.38)', 7);
  }

  resize(): void {
    if (fitCanvas(this.canvas)) {
      this.lastSeq = -1;
      this.askPat = hatch(this.ctx, 'rgba(230,159,0,0.38)', 7);
    }
  }

  draw(f: FrameMsg | null, priceDec: number, qtyDec: number, stale: boolean, rows = 14): void {
    this.points = 0;
    if (!f || (f.seq === this.lastSeq && stale === this.lastStale)) return;
    this.lastSeq = f.seq;
    this.lastStale = stale;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dpr = W / Math.max(1, this.canvas.clientWidth);
    ctx.clearRect(0, 0, W, H);
    const D = LADDER_DEPTH;
    const n = Math.min(rows, D);
    const header = 22 * dpr;
    const rh = (H - header - 26 * dpr) / (2 * n + 1);
    const fs = Math.min(13 * dpr, rh * 0.72);
    ctx.font = `${fs}px "JetBrains Mono", ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = stale ? 0.45 : 1;

    // columns (right edges)
    const xSide = 8 * dpr;
    const xPrice = W * 0.48;
    const xQty = W * 0.76;
    const xCum = W - 6 * dpr;
    ctx.fillStyle = C.dim;
    ctx.textAlign = 'right';
    ctx.font = `${11 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText('PRICE', xPrice, header / 2);
    ctx.fillText('SIZE', xQty, header / 2);
    ctx.fillText('CUM', xCum, header / 2);
    ctx.font = `${fs}px "JetBrains Mono", ui-monospace, Menlo, monospace`;

    let maxCum = 0;
    let cb = 0;
    let ca = 0;
    for (let d = 0; d < n; d++) {
      cb += f.ladder[D + d] || 0;
      ca += f.ladder[3 * D + d] || 0;
    }
    maxCum = Math.max(cb, ca, 1e-9);

    const row = (i: number): number => header + rh * i + rh / 2;
    const drawSide = (isBid: boolean): void => {
      let cum = 0;
      for (let d = 0; d < n; d++) {
        const px = f.ladder[(isBid ? 0 : 2 * D) + d]!;
        const q = f.ladder[(isBid ? D : 3 * D) + d]!;
        if (Number.isNaN(px)) continue;
        cum += q;
        // asks above the spread row (best ask nearest the middle), bids below
        const y = isBid ? row(n + 1 + d) : row(n - 1 - d);
        const bw = (cum / maxCum) * (W * 0.5);
        ctx.fillStyle = isBid ? 'rgba(0,114,178,0.32)' : this.askPat;
        ctx.fillRect(W - bw, y - rh / 2 + 1, bw, rh - 2);
        ctx.textAlign = 'left';
        ctx.fillStyle = isBid ? C.bid : C.ask;
        ctx.fillText(isBid ? 'B' : 'A', xSide, y);
        ctx.textAlign = 'right';
        ctx.fillText(fmtNum(px / 10 ** priceDec, priceDec), xPrice, y);
        ctx.fillStyle = C.text;
        ctx.fillText(q.toFixed(qtyDec), xQty, y);
        ctx.fillStyle = C.dim;
        ctx.fillText(cum.toFixed(Math.min(qtyDec, 3)), xCum, y);
        this.points++;
      }
    };
    drawSide(false);
    drawSide(true);

    // spread row
    const bb = f.ladder[0]!;
    const ba = f.ladder[2 * D]!;
    const ys = row(n);
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, ys - rh / 2, W, rh);
    ctx.textAlign = 'right';
    ctx.fillStyle = C.mid;
    if (!Number.isNaN(bb) && !Number.isNaN(ba)) {
      const spr = (ba - bb) / 10 ** priceDec;
      const mid = (ba + bb) / 2 / 10 ** priceDec;
      ctx.fillText(fmtNum(mid, priceDec + 1), xPrice, ys);
      ctx.fillStyle = C.dim;
      ctx.fillText(`spr ${fmtNum(spr, priceDec)}`, xCum, ys);
    } else {
      ctx.fillText('no book', xPrice, ys);
    }
    // footer
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.fillStyle = C.dim;
    ctx.font = `${10.5 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(`B = bid (solid) · A = ask (hatched) · top ${n} levels`, xSide, H - 12 * dpr);
    if (!f.valid) {
      ctx.fillStyle = 'rgba(213,94,0,0.88)';
      ctx.fillRect(0, H / 2 - 18 * dpr, W, 36 * dpr);
      ctx.fillStyle = '#000';
      ctx.textAlign = 'center';
      ctx.font = `bold ${13 * dpr}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(
        f.inGap ? 'BOOK INVALID — gap, awaiting resync' : 'NO BOOK YET — waiting for snapshot',
        W / 2,
        H / 2,
      );
    }
  }
}
