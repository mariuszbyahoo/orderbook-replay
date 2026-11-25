import { describe, expect, it } from 'vitest';
import { DepthSync, type DiffEvent } from '../src/engine/binanceSync';

const ev = (U: number, u: number): DiffEvent => ({ E: 0, U, u, b: [], a: [] });

describe('DepthSync (Binance local order book procedure)', () => {
  it('needs a buffered event before asking for a snapshot', () => {
    const s = new DepthSync();
    expect(s.wantsSnapshot).toBe(false);
    expect(s.onDiff(ev(10, 12)).kind).toBe('buffered');
    expect(s.wantsSnapshot).toBe(true);
  });

  it('retries when snapshot.lastUpdateId < first buffered U', () => {
    const s = new DepthSync();
    s.onDiff(ev(10, 12));
    expect(s.onSnapshot({ lastUpdateId: 9, bids: [], asks: [] }).kind).toBe('retry');
    expect(s.synced).toBe(false);
  });

  it('drops events with u <= lastUpdateId and applies the rest', () => {
    const s = new DepthSync();
    s.onDiff(ev(10, 12));
    s.onDiff(ev(13, 15));
    s.onDiff(ev(16, 20));
    const r = s.onSnapshot({ lastUpdateId: 14, bids: [], asks: [] });
    expect(r.kind).toBe('synced');
    if (r.kind !== 'synced') return;
    expect(r.applied.map((e) => e.U)).toEqual([13, 16]);
    expect(s.updateId).toBe(20);
  });

  it('applies contiguous live events, ignores old ones, flags gaps', () => {
    const s = new DepthSync();
    s.onDiff(ev(10, 12));
    s.onSnapshot({ lastUpdateId: 11, bids: [], asks: [] });
    expect(s.onDiff(ev(13, 14)).kind).toBe('applied');
    expect(s.onDiff(ev(5, 8)).kind).toBe('ignored');
    const g = s.onDiff(ev(20, 22));
    expect(g).toEqual({ kind: 'gap', bookId: 14, U: 20 });
    expect(s.synced).toBe(false);
    expect(s.wantsSnapshot).toBe(true); // the gapped event is buffered for the resync
  });

  it('retries when the first remaining event does not straddle lastUpdateId', () => {
    const s = new DepthSync();
    s.onDiff(ev(10, 12));
    s.onDiff(ev(20, 25)); // 13..19 missing
    expect(s.onSnapshot({ lastUpdateId: 15, bids: [], asks: [] }).kind).toBe('retry');
  });
});
