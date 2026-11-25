/**
 * Deterministic cursor over a Session: rebuilds the book at any point in time.
 * Seeking restores the nearest earlier checkpoint and rolls forward, so cost is bounded by the
 * checkpoint interval, not by session length.
 */
import { OrderBook } from './orderbook';
import { EV_DEPTH, EV_GAP, EV_SNAP, EV_TRADE, type Session } from './session';

export interface ReplayCounters {
  applied: number;
  stale: number;
  gaps: number;
  crossed: number;
  trades: number;
}

export interface PassHooks {
  before?(i: number, t: number): void;
  after?(i: number, kind: number, t: number): void;
}

interface Checkpoint {
  cursor: number;
  book: OrderBook;
  lastTrade: number;
}

export class ReplayEngine {
  readonly book: OrderBook;
  /** index of the next event to apply */
  cursor = 0;
  /** index of the last trade event applied, -1 if none */
  lastTrade = -1;
  /** set by a gap; cleared by the next snapshot */
  inGap = false;
  counters: ReplayCounters = { applied: 0, stale: 0, gaps: 0, crossed: 0, trades: 0 };
  private checkpoints: Checkpoint[] = [];

  constructor(
    readonly s: Session,
    readonly checkpointEveryMs = 15_000,
  ) {
    this.book = new OrderBook(s.scale);
  }

  /** One full pass to build checkpoints. Leaves the engine reset at the start. */
  buildCheckpoints(hooks?: PassHooks): ReplayCounters {
    this.checkpoints = [];
    this.reset();
    let next = this.s.startTime;
    while (this.cursor < this.s.length) {
      const i = this.cursor;
      const t = this.s.time[i]!;
      if (t >= next && this.book.valid) {
        const b = new OrderBook(this.s.scale);
        b.copyFrom(this.book);
        this.checkpoints.push({ cursor: i, book: b, lastTrade: this.lastTrade });
        next = t + this.checkpointEveryMs;
      }
      hooks?.before?.(i, t);
      const k = this.applyNext();
      hooks?.after?.(i, k, t);
    }
    const totals = this.counters;
    this.reset();
    return totals;
  }

  get checkpointCount(): number {
    return this.checkpoints.length;
  }

  reset(): void {
    this.cursor = 0;
    this.lastTrade = -1;
    this.inGap = false;
    this.book.valid = false;
    this.book.updateId = 0;
    this.book.bids.clear();
    this.book.asks.clear();
    this.counters = { applied: 0, stale: 0, gaps: 0, crossed: 0, trades: 0 };
  }

  /** Time of the most recently applied event (exchange ms), or session start. */
  get time(): number {
    return this.cursor > 0 ? this.s.time[this.cursor - 1]! : this.s.startTime;
  }

  get done(): boolean {
    return this.cursor >= this.s.length;
  }

  /** Apply exactly one event. Returns its kind, or -1 at end. */
  applyNext(): number {
    const s = this.s;
    const i = this.cursor;
    if (i >= s.length) return -1;
    this.cursor++;
    const k = s.kind[i]!;
    const lv0 = s.lv0[i]!;
    const nb = s.nb[i]!;
    const na = s.na[i]!;
    const book = this.book;
    if (k === EV_SNAP) {
      book.bids.clear();
      book.asks.clear();
      book.applyLevels('b', s.lvTicks, s.lvQty, lv0, lv0 + nb);
      book.applyLevels('a', s.lvTicks, s.lvQty, lv0 + nb, lv0 + nb + na);
      book.updateId = s.u[i]!;
      book.valid = true;
      this.inGap = false;
    } else if (k === EV_DEPTH) {
      if (!book.valid) {
        this.counters.stale++;
      } else if (s.u[i]! < book.updateId) {
        this.counters.stale++;
      } else if (s.U[i]! > book.updateId + 1) {
        book.valid = false;
        this.inGap = true;
        this.counters.gaps++;
      } else {
        book.applyLevels('b', s.lvTicks, s.lvQty, lv0, lv0 + nb);
        book.applyLevels('a', s.lvTicks, s.lvQty, lv0 + nb, lv0 + nb + na);
        book.updateId = s.u[i]!;
        this.counters.applied++;
        if (book.isCrossed()) this.counters.crossed++;
      }
    } else if (k === EV_TRADE) {
      this.lastTrade = i;
      this.counters.trades++;
    } else if (k === EV_GAP) {
      book.valid = false;
      this.inGap = true;
      this.counters.gaps++;
    }
    return k;
  }

  /** Apply all events with time <= t. Returns number applied. */
  advanceTo(t: number): number {
    const s = this.s;
    let n = 0;
    while (this.cursor < s.length && s.time[this.cursor]! <= t) {
      this.applyNext();
      n++;
    }
    return n;
  }

  /** Jump to time t (forward or backward). */
  seek(t: number): void {
    if (t >= this.time && this.cursor > 0) {
      this.advanceTo(t);
      return;
    }
    let lo = 0;
    let hi = this.checkpoints.length - 1;
    let best = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const cp = this.checkpoints[m]!;
      if (this.s.time[cp.cursor]! <= t) {
        best = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    this.reset();
    if (best >= 0) {
      const cp = this.checkpoints[best]!;
      this.book.copyFrom(cp.book);
      this.cursor = cp.cursor;
      this.lastTrade = cp.lastTrade;
    }
    this.advanceTo(t);
  }

  /** Jump so that exactly `n` events have been applied. */
  seekCursor(n: number): void {
    n = Math.max(0, Math.min(this.s.length, n));
    if (n >= this.cursor && this.cursor > 0) {
      while (this.cursor < n) this.applyNext();
      return;
    }
    let best: Checkpoint | null = null;
    for (const cp of this.checkpoints) {
      if (cp.cursor <= n) best = cp;
      else break;
    }
    this.reset();
    if (best) {
      this.book.copyFrom(best.book);
      this.cursor = best.cursor;
      this.lastTrade = best.lastTrade;
    }
    while (this.cursor < n) this.applyNext();
  }
}
