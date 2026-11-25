/**
 * L2 order book on typed arrays.
 *
 * Prices are integer ticks (price / tickSize), so comparisons are exact. Each side keeps its
 * levels sorted "worst -> best" so the best level sits at the END of the array: most updates
 * land near the top of the book, and inserting/removing near the tail moves few elements.
 *   bids: ascending ticks   (best bid = highest = last)
 *   asks: descending ticks  (best ask = lowest  = last), stored as negated ticks ascending
 */

export class BookSide {
  /** sort key: +ticks for bids, -ticks for asks; ascending */
  private keys: Float64Array;
  private qtys: Float64Array;
  private n = 0;

  constructor(
    readonly sign: 1 | -1,
    capacity = 1024,
  ) {
    this.keys = new Float64Array(capacity);
    this.qtys = new Float64Array(capacity);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  /** index of first key >= k */
  private lowerBound(k: number): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.keys[mid]! < k) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Set absolute quantity at a price; qty <= 0 removes the level. Returns true if book changed. */
  set(ticks: number, qty: number): boolean {
    const k = ticks * this.sign;
    const i = this.lowerBound(k);
    const exists = i < this.n && this.keys[i] === k;
    if (qty <= 0) {
      if (!exists) return false;
      this.keys.copyWithin(i, i + 1, this.n);
      this.qtys.copyWithin(i, i + 1, this.n);
      this.n--;
      return true;
    }
    if (exists) {
      this.qtys[i] = qty;
      return true;
    }
    if (this.n === this.keys.length) this.grow();
    this.keys.copyWithin(i + 1, i, this.n);
    this.qtys.copyWithin(i + 1, i, this.n);
    this.keys[i] = k;
    this.qtys[i] = qty;
    this.n++;
    return true;
  }

  get(ticks: number): number {
    const k = ticks * this.sign;
    const i = this.lowerBound(k);
    return i < this.n && this.keys[i] === k ? this.qtys[i]! : 0;
  }

  /** Price (ticks) of the d-th best level, d = 0 is best. NaN if absent. */
  priceAt(d: number): number {
    const i = this.n - 1 - d;
    return i >= 0 ? this.keys[i]! * this.sign : NaN;
  }

  qtyAt(d: number): number {
    const i = this.n - 1 - d;
    return i >= 0 ? this.qtys[i]! : 0;
  }

  /** Visit levels from best outward; return false from fn to stop. */
  forEach(fn: (ticks: number, qty: number, depth: number) => unknown): void {
    for (let i = this.n - 1, d = 0; i >= 0; i--, d++) {
      if (fn(this.keys[i]! * this.sign, this.qtys[i]!, d) === false) return;
    }
  }

  /** Drop levels whose price falls outside [lo, hi] ticks. */
  trim(lo: number, hi: number): void {
    let w = 0;
    for (let r = 0; r < this.n; r++) {
      const p = this.keys[r]! * this.sign;
      if (p < lo || p > hi) continue;
      this.keys[w] = this.keys[r]!;
      this.qtys[w] = this.qtys[r]!;
      w++;
    }
    this.n = w;
  }

  copyFrom(o: BookSide): void {
    if (this.keys.length < o.n) {
      this.keys = new Float64Array(o.keys.length);
      this.qtys = new Float64Array(o.keys.length);
    }
    this.keys.set(o.keys.subarray(0, o.n));
    this.qtys.set(o.qtys.subarray(0, o.n));
    this.n = o.n;
  }

  private grow(): void {
    const k = new Float64Array(this.keys.length * 2);
    const q = new Float64Array(this.keys.length * 2);
    k.set(this.keys);
    q.set(this.qtys);
    this.keys = k;
    this.qtys = q;
  }
}

export type RawLevel = readonly [string, string];

export interface PriceScale {
  /** decimals implied by tickSize, e.g. 0.01 -> 2 */
  decimals: number;
  toTicks(price: string | number): number;
  toPrice(ticks: number): number;
}

export function priceScale(tickSize: string): PriceScale {
  const t = Number(tickSize);
  const decimals = Math.max(0, Math.round(-Math.log10(t)));
  const mul = 10 ** decimals;
  return {
    decimals,
    toTicks: (p) => Math.round(Number(p) * mul),
    toPrice: (ticks) => ticks / mul,
  };
}

export type ApplyResult = 'applied' | 'stale' | 'gap';

export class OrderBook {
  readonly bids = new BookSide(1);
  readonly asks = new BookSide(-1);
  /** last applied update id; 0 = no valid book */
  updateId = 0;
  valid = false;

  constructor(readonly scale: PriceScale) {}

  loadSnapshot(lastUpdateId: number, bids: readonly RawLevel[], asks: readonly RawLevel[]): void {
    this.bids.clear();
    this.asks.clear();
    for (const [p, q] of bids) this.bids.set(this.scale.toTicks(p), Number(q));
    for (const [p, q] of asks) this.asks.set(this.scale.toTicks(p), Number(q));
    this.updateId = lastUpdateId;
    this.valid = true;
  }

  /**
   * Apply a diff with Binance continuity rules: stale if u < updateId, gap if U > updateId + 1.
   * On gap the book is marked invalid and must be reloaded from a snapshot.
   */
  applyDiff(U: number, u: number, bids: readonly RawLevel[], asks: readonly RawLevel[]): ApplyResult {
    if (!this.valid) return 'gap';
    if (u < this.updateId) return 'stale';
    if (U > this.updateId + 1) {
      this.valid = false;
      return 'gap';
    }
    for (const [p, q] of bids) this.bids.set(this.scale.toTicks(p), Number(q));
    for (const [p, q] of asks) this.asks.set(this.scale.toTicks(p), Number(q));
    this.updateId = u;
    return 'applied';
  }

  /** Apply already-parsed levels (replay fast path, continuity checked upstream). */
  applyLevels(side: 'b' | 'a', ticks: ArrayLike<number>, qtys: ArrayLike<number>, from: number, to: number): void {
    const s = side === 'b' ? this.bids : this.asks;
    for (let i = from; i < to; i++) s.set(ticks[i]!, qtys[i]!);
  }

  bestBid(): number {
    return this.bids.priceAt(0);
  }

  bestAsk(): number {
    return this.asks.priceAt(0);
  }

  /** best bid >= best ask: impossible on a consistent exchange book; signals corrupt state. */
  isCrossed(): boolean {
    const b = this.bestBid();
    const a = this.bestAsk();
    return !Number.isNaN(b) && !Number.isNaN(a) && b >= a;
  }

  copyFrom(o: OrderBook): void {
    this.bids.copyFrom(o.bids);
    this.asks.copyFrom(o.asks);
    this.updateId = o.updateId;
    this.valid = o.valid;
  }
}
