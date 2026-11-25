/**
 * Binance spot "How to manage a local order book correctly", as a pure state machine.
 * No I/O here: the caller feeds stream events and REST snapshots, and acts on the result.
 * Shared by the recorder (Node) and live mode (browser worker).
 *
 * Procedure (binance-spot-api-docs, web-socket-streams.md):
 *  1-2. buffer stream events, note U of the first one
 *  3-4. fetch snapshot; if lastUpdateId < firstU, fetch again
 *  5.   drop buffered events with u <= lastUpdateId
 *  6.   book := snapshot, id := lastUpdateId
 *  7.   apply each event: ignore if u < id; gap if U > id + 1 (restart); else apply, id := u
 */

export type Level = [price: string, qty: string];

export interface DiffEvent {
  E: number;
  U: number;
  u: number;
  b: Level[];
  a: Level[];
}

export interface Snapshot {
  lastUpdateId: number;
  bids: Level[];
  asks: Level[];
}

export type DiffResult =
  | { kind: 'buffered' }
  | { kind: 'ignored' }
  | { kind: 'applied'; ev: DiffEvent }
  | { kind: 'gap'; bookId: number; U: number };

export type SnapshotResult =
  { kind: 'retry'; reason: string } | { kind: 'synced'; snapshot: Snapshot; applied: DiffEvent[] };

export class DepthSync {
  private state: 'buffering' | 'synced' = 'buffering';
  private buffer: DiffEvent[] = [];
  private bookId = 0;

  get synced(): boolean {
    return this.state === 'synced';
  }

  get updateId(): number {
    return this.bookId;
  }

  /** Step 3 may only start once at least one event is buffered (we need its U). */
  get wantsSnapshot(): boolean {
    return this.state === 'buffering' && this.buffer.length > 0;
  }

  onDiff(ev: DiffEvent): DiffResult {
    if (this.state === 'buffering') {
      this.buffer.push(ev);
      return { kind: 'buffered' };
    }
    return this.applyOne(ev);
  }

  onSnapshot(snap: Snapshot): SnapshotResult {
    const first = this.buffer[0];
    if (this.state !== 'buffering' || !first) {
      return { kind: 'retry', reason: 'no buffered event yet' };
    }
    if (snap.lastUpdateId < first.U) {
      return { kind: 'retry', reason: `snapshot ${snap.lastUpdateId} older than first U ${first.U}` };
    }
    const pending = this.buffer.filter((e) => e.u > snap.lastUpdateId);
    const head = pending[0];
    if (head && !(head.U <= snap.lastUpdateId + 1 && snap.lastUpdateId <= head.u)) {
      // First remaining event must straddle lastUpdateId; otherwise events were lost in between.
      this.buffer = pending;
      return { kind: 'retry', reason: `first event [${head.U};${head.u}] does not cover ${snap.lastUpdateId}` };
    }
    this.buffer = [];
    this.state = 'synced';
    this.bookId = snap.lastUpdateId;
    const applied: DiffEvent[] = [];
    for (const ev of pending) {
      const r = this.applyOne(ev);
      if (r.kind === 'applied') applied.push(ev);
      else if (r.kind === 'gap') return { kind: 'retry', reason: 'gap inside buffer' };
    }
    return { kind: 'synced', snapshot: snap, applied };
  }

  /** Force a full resync (e.g. after reconnect). */
  reset(): void {
    this.state = 'buffering';
    this.buffer = [];
    this.bookId = 0;
  }

  private applyOne(ev: DiffEvent): DiffResult {
    if (ev.u < this.bookId) return { kind: 'ignored' };
    if (ev.U > this.bookId + 1) {
      const bookId = this.bookId;
      this.state = 'buffering';
      this.buffer = [ev];
      this.bookId = 0;
      return { kind: 'gap', bookId, U: ev.U };
    }
    this.bookId = ev.u;
    return { kind: 'applied', ev };
  }
}
