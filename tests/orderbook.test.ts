import { describe, expect, it } from 'vitest';
import { BookSide, OrderBook, priceScale } from '../src/engine/orderbook';

const sc = priceScale('0.01000000');

describe('priceScale', () => {
  it('derives decimals and converts exactly', () => {
    expect(sc.decimals).toBe(2);
    expect(sc.toTicks('59543.18000000')).toBe(5954318);
    expect(sc.toPrice(5954318)).toBe(59543.18);
    expect(priceScale('0.00001000').decimals).toBe(5);
  });
});

describe('BookSide', () => {
  it('keeps bids best-first (highest) and supports insert/overwrite/delete', () => {
    const s = new BookSide(1, 2); // tiny capacity forces growth
    s.set(100, 1);
    s.set(102, 2);
    s.set(101, 3);
    expect([s.priceAt(0), s.priceAt(1), s.priceAt(2)]).toEqual([102, 101, 100]);
    s.set(101, 5); // overwrite
    expect(s.get(101)).toBe(5);
    expect(s.size).toBe(3);
    expect(s.set(101, 0)).toBe(true); // delete
    expect(s.get(101)).toBe(0);
    expect(s.size).toBe(2);
    expect(s.set(999, 0)).toBe(false); // deleting a missing level is a no-op
  });

  it('keeps asks best-first (lowest)', () => {
    const s = new BookSide(-1);
    s.set(205, 1);
    s.set(201, 1);
    s.set(203, 1);
    const seen: number[] = [];
    s.forEach((p) => {
      seen.push(p);
    });
    expect(seen).toEqual([201, 203, 205]);
    expect(s.priceAt(3)).toBeNaN();
  });

  it('trims to a price band', () => {
    const s = new BookSide(1);
    for (let p = 1; p <= 10; p++) s.set(p, p);
    s.trim(3, 6);
    expect(s.size).toBe(4);
    expect(s.priceAt(0)).toBe(6);
  });
});

describe('OrderBook', () => {
  const snap = (): OrderBook => {
    const b = new OrderBook(sc);
    b.loadSnapshot(
      100,
      [
        ['10.00', '1'],
        ['9.99', '2'],
      ],
      [
        ['10.01', '3'],
        ['10.02', '4'],
      ],
    );
    return b;
  };

  it('applies a contiguous diff: overwrite, insert, delete', () => {
    const b = snap();
    expect(
      b.applyDiff(
        101,
        105,
        [
          ['10.00', '5'],
          ['9.99', '0'],
        ],
        [['10.03', '1']],
      ),
    ).toBe('applied');
    expect(b.bids.get(1000)).toBe(5);
    expect(b.bids.get(999)).toBe(0);
    expect(b.asks.get(1003)).toBe(1);
    expect(b.updateId).toBe(105);
  });

  it('accepts the straddling first event (U <= id+1 <= u)', () => {
    const b = snap();
    expect(b.applyDiff(95, 110, [], [])).toBe('applied');
    expect(b.updateId).toBe(110);
  });

  it('ignores stale events (u < id)', () => {
    const b = snap();
    expect(b.applyDiff(90, 99, [['10.00', '9']], [])).toBe('stale');
    expect(b.bids.get(1000)).toBe(1);
  });

  it('detects gaps (U > id + 1) and invalidates the book', () => {
    const b = snap();
    expect(b.applyDiff(102, 104, [], [])).toBe('gap');
    expect(b.valid).toBe(false);
    expect(b.applyDiff(105, 106, [], [])).toBe('gap'); // stays invalid until a new snapshot
  });

  it('detects a crossed book', () => {
    const b = snap();
    expect(b.isCrossed()).toBe(false);
    b.applyDiff(101, 101, [['10.01', '1']], []); // bid at the ask
    expect(b.isCrossed()).toBe(true);
  });
});
