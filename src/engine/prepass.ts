/**
 * One pass over a recorded session: builds seek checkpoints and the full history (heatmap raster,
 * per-second stats, strategy decisions) that the views reveal up to the playhead.
 */
import { Analyzer, makeGrid, type Grid, type HistoryPatch } from './analyzer';
import { ReplayEngine, type ReplayCounters } from './replay';
import { EV_DEPTH, EV_GAP, EV_SNAP, EV_TRADE, type Session } from './session';
import { DEFAULT_PARAMS, type StrategyParams } from './strategy';

export interface Prepass {
  engine: ReplayEngine;
  grid: Grid;
  patch: HistoryPatch;
  totals: ReplayCounters;
  ms: number;
}

/** Raster price range: traded range plus padding (fraction of mid). */
export function replayGrid(s: Session, padFrac = 0.0025): Grid {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < s.length; i++) {
    if (s.kind[i] !== EV_TRADE) continue;
    const p = s.lvTicks[s.lv0[i]!]!;
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  if (!Number.isFinite(lo)) {
    lo = hi = s.lvTicks[0] ?? 0;
  }
  const mid = (lo + hi) / 2;
  return makeGrid(mid, s.startTime, (hi - lo) / 2 + mid * padFrac);
}

export function prepass(s: Session, params: StrategyParams = DEFAULT_PARAMS): Prepass {
  const t0 = performance.now();
  const grid = replayGrid(s);
  const engine = new ReplayEngine(s);
  const an = new Analyzer(grid, params, s.scale.toPrice);
  const book = engine.book;
  const totals = engine.buildCheckpoints({
    before: (_i, t) => an.tick(t, book),
    after: (i, k, t) => {
      if (k === EV_DEPTH || k === EV_SNAP) an.onDepth(t, book);
      else if (k === EV_TRADE) an.onTrade(s.nb[i]! > 0, s.lvQty[s.lv0[i]!]!);
      else if (k === EV_GAP) an.onGap();
    },
  });
  // close the final partial bucket with the end-of-session book
  engine.seek(s.endTime);
  an.closeBucket(engine.book);
  engine.reset();
  return { engine, grid, patch: an.drain(), totals, ms: performance.now() - t0 };
}
