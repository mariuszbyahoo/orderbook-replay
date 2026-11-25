/**
 * ILLUSTRATIVE strategy — not a trading recommendation and not expected to be profitable.
 * It exists to show decisions rendered against the book they were made on.
 *
 * Signal: top-of-book imbalance over the best `depth` levels,
 *   I = (sum bidQty - sum askQty) / (sum bidQty + sum askQty)  in [-1, 1],
 * smoothed with an EMA per book update.
 * Rules: flat -> long if I > enter, flat -> short if I < -enter;
 *        exit long if I < exit, exit short if I > -exit; hold at least minHoldMs.
 * Fills: taker at the touch (buy at best ask, sell at best bid). No fees, no latency, no queue.
 */
import type { OrderBook } from './orderbook';

export interface StrategyParams {
  depth: number;
  enter: number;
  exit: number;
  emaAlpha: number;
  minHoldMs: number;
  /** position size in base units (BTC) */
  size: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  depth: 5,
  enter: 0.6,
  exit: 0.0,
  emaAlpha: 0.2,
  minHoldMs: 3000,
  size: 0.01,
};

export const D_ENTER_LONG = 1;
export const D_EXIT_LONG = 2;
export const D_ENTER_SHORT = 3;
export const D_EXIT_SHORT = 4;

export interface Decision {
  t: number;
  kind: number;
  /** fill price in ticks */
  price: number;
  signal: number;
  /** position after the decision, in base units */
  pos: number;
  /** cumulative realised PnL after the decision, quote currency */
  realized: number;
}

export function imbalance(book: OrderBook, depth: number): number {
  let b = 0;
  let a = 0;
  for (let d = 0; d < depth; d++) {
    b += book.bids.qtyAt(d);
    a += book.asks.qtyAt(d);
  }
  return b + a > 0 ? (b - a) / (b + a) : 0;
}

export class ImbalanceStrategy {
  signal = 0;
  pos = 0;
  entry = 0;
  realized = 0;
  private since = -Infinity;
  private primed = false;

  constructor(
    readonly p: StrategyParams = DEFAULT_PARAMS,
    readonly toPrice: (ticks: number) => number = (t) => t / 100,
  ) {}

  reset(): void {
    this.signal = 0;
    this.pos = 0;
    this.entry = 0;
    this.realized = 0;
    this.since = -Infinity;
    this.primed = false;
  }

  /** Call after every applied book update. Returns a decision or null. */
  onBook(t: number, book: OrderBook): Decision | null {
    if (!book.valid || book.isCrossed()) return null;
    const raw = imbalance(book, this.p.depth);
    this.signal = this.primed ? this.signal + this.p.emaAlpha * (raw - this.signal) : raw;
    this.primed = true;
    if (t - this.since < this.p.minHoldMs) return null;
    const bid = book.bestBid();
    const ask = book.bestAsk();
    if (Number.isNaN(bid) || Number.isNaN(ask)) return null;
    const s = this.signal;
    const { enter, exit, size } = this.p;
    let kind = 0;
    let px = 0;
    if (this.pos === 0) {
      if (s > enter) {
        kind = D_ENTER_LONG;
        px = ask;
        this.pos = size;
        this.entry = this.toPrice(ask);
      } else if (s < -enter) {
        kind = D_ENTER_SHORT;
        px = bid;
        this.pos = -size;
        this.entry = this.toPrice(bid);
      }
    } else if (this.pos > 0 && s < exit) {
      kind = D_EXIT_LONG;
      px = bid;
      this.realized += (this.toPrice(bid) - this.entry) * this.pos;
      this.pos = 0;
    } else if (this.pos < 0 && s > -exit) {
      kind = D_EXIT_SHORT;
      px = ask;
      this.realized += (this.toPrice(ask) - this.entry) * this.pos;
      this.pos = 0;
    }
    if (!kind) return null;
    this.since = t;
    return { t, kind, price: px, signal: s, pos: this.pos, realized: this.realized };
  }
}
