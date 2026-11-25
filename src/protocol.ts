/** Messages between the main thread (render only) and the engine worker (data + clock). */
import type { Grid } from './engine/analyzer';
import type { Decision } from './engine/strategy';

export type StepUnit = 'event' | '100ms' | '1s';

export type ToWorker =
  | { type: 'load'; url: string }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; x: number }
  | { type: 'step'; unit: StepUnit; dir: 1 | -1 }
  | { type: 'seek'; t: number }
  | { type: 'live'; on: boolean }
  | { type: 'bench'; on: boolean }
  | { type: 'freeze'; ms: number };

export interface InstrumentInfo {
  symbol: string;
  priceDecimals: number;
  qtyDecimals: number;
  source: string;
}

export interface TradesChunk {
  t: Float64Array;
  /** ticks */
  p: Float64Array;
  q: Float64Array;
  /** 1 = aggressor buy, 0 = aggressor sell */
  side: Uint8Array;
}

export interface HistoryMsg {
  col0: number;
  ncols: number;
  stats: Float64Array;
  /** ncols x rows image, column 0 at x = 0, highest price at y = 0 */
  bitmap: ImageBitmap | null;
  decisions: Decision[];
  trades: TradesChunk;
}

export interface ResetMsg {
  type: 'reset';
  mode: 'replay' | 'live';
  instrument: InstrumentInfo;
  grid: Grid;
  /** capacity in buckets (replay: whole session) */
  capacity: number;
  start: number;
  end: number;
  history: HistoryMsg;
  info: Record<string, string | number>;
}

export const LADDER_DEPTH = 20;

export interface FrameMsg {
  type: 'frame';
  seq: number;
  /** absolute ms (timeOrigin + now) when posted, for worker->main lag */
  sentAt: number;
  mode: 'replay' | 'live';
  playing: boolean;
  speed: number;
  /** replay playhead (exchange ms); live: estimated exchange "now" */
  now: number;
  /** exchange time of the last event applied */
  lastEventT: number;
  cursor: number;
  total: number;
  valid: boolean;
  inGap: boolean;
  /** live: websocket state */
  link: 'ok' | 'connecting' | 'down' | 'n/a';
  /** [bidPx x D, bidQty x D, askPx x D, askQty x D], ticks / base units, NaN for missing */
  ladder: Float64Array;
  /** applied events since previous frame (coalesced) */
  eventsSinceLast: number;
  pos: number;
  realized: number;
  signal: number;
  counters: { gaps: number; crossed: number; stale: number };
}

export interface PatchMsg {
  type: 'patch';
  end: number;
  history: HistoryMsg;
}

export interface StatusMsg {
  type: 'status';
  text: string;
  error?: boolean;
}

export type FromWorker = ResetMsg | FrameMsg | PatchMsg | StatusMsg;
