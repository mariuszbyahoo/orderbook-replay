/** One JSON object per line in data/*.jsonl.gz. Prices/quantities stay as exchange strings. */
import type { Level } from './binanceSync';

export interface MetaRec {
  k: 'meta';
  symbol: string;
  tickSize: string;
  stepSize: string;
  source: string;
  startedAt: number;
  note?: string;
  band?: [number, number];
}
/** t = local receive time (ms), E/T = exchange timestamps (ms). */
export interface SnapRec {
  k: 'snap';
  t: number;
  E: number;
  id: number;
  b: Level[];
  a: Level[];
}
export interface DepthRec {
  k: 'depth';
  t: number;
  E: number;
  U: number;
  u: number;
  b: Level[];
  a: Level[];
}
export interface TradeRec {
  k: 'trade';
  t: number;
  E: number;
  T: number;
  id: number;
  p: string;
  q: string;
  /** buyer is maker => aggressor sold */
  m: boolean;
}
export interface GapRec {
  k: 'gap';
  t: number;
  reason: string;
}
export type Rec = MetaRec | SnapRec | DepthRec | TradeRec | GapRec;
