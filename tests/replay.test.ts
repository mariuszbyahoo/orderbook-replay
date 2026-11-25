import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import type { Rec } from '../src/engine/format';
import { loadSession, Session } from '../src/engine/session';
import { ReplayEngine } from '../src/engine/replay';
import { prepass } from '../src/engine/prepass';
import { S, NSTAT } from '../src/engine/analyzer';
import { D_ENTER_LONG, D_EXIT_LONG, ImbalanceStrategy } from '../src/engine/strategy';
import { OrderBook, priceScale } from '../src/engine/orderbook';

const meta: Rec = { k: 'meta', symbol: 'TEST', tickSize: '0.01', stepSize: '0.001', source: 'test', startedAt: 0 };

function synthetic(): Rec[] {
  const recs: Rec[] = [meta];
  recs.push({ k: 'snap', t: 1000, E: 1000, id: 100, b: [['100.00', '1']], a: [['100.02', '1']] });
  let id = 100;
  for (let i = 1; i <= 50; i++) {
    const t = 1000 + i * 100;
    recs.push({ k: 'depth', t, E: t, U: id + 1, u: id + 2, b: [['100.00', String(1 + i)]], a: [] });
    id += 2;
    if (i % 10 === 0) recs.push({ k: 'trade', t, E: t, T: t, id: i, p: '100.01', q: '0.5', m: i % 20 === 0 });
  }
  return recs;
}

function build(recs: Rec[]): Session {
  const s = new Session();
  for (const r of recs) s.add(r);
  return s;
}

describe('Session', () => {
  it('parses gzip JSONL via DecompressionStream', async () => {
    const gz = gzipSync(
      synthetic()
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    const s = await loadSession(new Blob([gz]).stream());
    expect(s.length).toBe(1 + 50 + 5);
    expect(s.meta?.symbol).toBe('TEST');
  });

  it('clamps non-monotonic exchange time', () => {
    const s = build([
      meta,
      { k: 'trade', t: 0, E: 0, T: 2000, id: 1, p: '1', q: '1', m: false },
      { k: 'trade', t: 0, E: 0, T: 1500, id: 2, p: '1', q: '1', m: false },
    ]);
    expect(s.clamped).toBe(1);
    expect(s.time[1]).toBe(2000);
  });

  it('applies a price band at ingest', () => {
    const s = new Session();
    s.add({ ...meta, band: [9000, 11000] } as Rec);
    s.add({
      k: 'snap',
      t: 0,
      E: 0,
      id: 1,
      b: [
        ['100.00', '1'],
        ['50.00', '1'],
      ],
      a: [['200.00', '1']],
    });
    expect(s.nb[0]).toBe(1);
    expect(s.na[0]).toBe(0);
  });
});

describe('ReplayEngine', () => {
  it('reconstructs the book and seeks backward/forward deterministically', () => {
    const s = build(synthetic());
    const e = new ReplayEngine(s, 1000);
    e.buildCheckpoints();
    expect(e.checkpointCount).toBeGreaterThan(2);
    e.advanceTo(s.endTime);
    expect(e.book.bids.get(10000)).toBe(51);
    expect(e.counters.trades).toBe(5);
    e.seek(1000 + 25 * 100);
    expect(e.book.bids.get(10000)).toBe(26);
    e.seek(1000 + 49 * 100);
    expect(e.book.bids.get(10000)).toBe(50);
    expect(e.counters.gaps).toBe(0);
  });

  it('flags a gap and recovers on the next snapshot', () => {
    const recs = synthetic().slice(0, 5);
    recs.push({ k: 'depth', t: 2000, E: 2000, U: 999, u: 1000, b: [], a: [] }); // gap
    recs.push({ k: 'snap', t: 2100, E: 2100, id: 2000, b: [['99.00', '1']], a: [['99.10', '1']] });
    const e = new ReplayEngine(build(recs));
    e.advanceTo(2000);
    expect(e.inGap).toBe(true);
    expect(e.book.valid).toBe(false);
    e.advanceTo(2100);
    expect(e.inGap).toBe(false);
    expect(e.book.bestBid()).toBe(9900);
  });

  it('counts crossed books', () => {
    const recs: Rec[] = [meta, { k: 'snap', t: 0, E: 0, id: 1, b: [['1.00', '1']], a: [['1.01', '1']] }];
    recs.push({ k: 'depth', t: 1, E: 1, U: 2, u: 2, b: [['1.02', '1']], a: [] });
    const e = new ReplayEngine(build(recs));
    e.advanceTo(10);
    expect(e.counters.crossed).toBe(1);
  });
});

describe('prepass / analyzer', () => {
  it('produces one bucket per second with sample counts and min/max', () => {
    const s = build(synthetic());
    const p = prepass(s);
    expect(p.patch.ncols).toBe(6); // 1000..6000 ms
    const st = p.patch.stats;
    expect(st.length).toBe(p.patch.ncols * NSTAT);
    // bucket 1 (2000..2999 ms) has 10 depth updates
    expect(st[1 * NSTAT + S.nDepth]).toBe(10);
    expect(st[1 * NSTAT + S.midN]).toBe(10);
    expect(st[1 * NSTAT + S.midMin]).toBe(10001);
    expect(p.patch.bidRaster.length).toBe(p.patch.ncols * p.grid.rows);
    expect(p.patch.bidRaster.some((v) => v > 0)).toBe(true);
  });
});

describe('ImbalanceStrategy', () => {
  it('enters long on bid-heavy book and exits when it flips', () => {
    const sc = priceScale('0.01');
    const b = new OrderBook(sc);
    const st = new ImbalanceStrategy({ depth: 1, enter: 0.5, exit: 0, emaAlpha: 1, minHoldMs: 0, size: 1 }, sc.toPrice);
    b.loadSnapshot(1, [['100.00', '9']], [['100.02', '1']]);
    const d1 = st.onBook(0, b);
    expect(d1?.kind).toBe(D_ENTER_LONG);
    expect(d1?.price).toBe(10002);
    b.loadSnapshot(2, [['100.10', '1']], [['100.12', '9']]);
    const d2 = st.onBook(1, b);
    expect(d2?.kind).toBe(D_EXIT_LONG);
    expect(d2?.realized).toBeCloseTo(0.08); // bought 100.02, sold 100.10
    expect(st.pos).toBe(0);
  });
});
