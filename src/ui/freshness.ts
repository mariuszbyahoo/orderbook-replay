import type { FrameMsg } from '../protocol';
import { fmtDur } from '../render/util';

export interface Fresh {
  ageMs: number;
  stale: boolean;
  label: string;
  cls: 'ok' | 'paused' | 'stale';
}

type FrameLike = Pick<FrameMsg, 'mode' | 'playing' | 'speed' | 'now' | 'lastEventT' | 'sentAt' | 'link' | 'valid'>;

/**
 * How far behind "now" the data on screen is.
 *   live:   exchange-clock now (server-offset corrected, computed in the worker) minus the last
 *           event's exchange time, plus wall time since the worker produced the frame
 *   replay: playhead minus last event time (exposes gaps in the recording), plus wall delay since
 *           the frame was produced scaled by playback speed (a stalled pipeline at 100x is 100x stale)
 * Also stale: no frames for > silentMs while time should be moving, link down, book invalid.
 */
export function freshness(f: FrameLike | null, nowAbs: number, staleMs = 1500, silentMs = 750): Fresh {
  if (!f) return { ageMs: NaN, stale: true, label: 'no data', cls: 'stale' };
  const wall = Math.max(0, nowAbs - f.sentAt);
  const moving = f.mode === 'live' || f.playing;
  const scale = f.mode === 'live' ? 1 : f.playing ? f.speed : 0;
  const age = Math.max(0, f.now - f.lastEventT) + wall * scale;
  const silent = moving && wall > silentMs;
  const stale = age > staleMs || silent || f.link === 'down' || !f.valid;
  const why = !f.valid ? ' · book invalid' : f.link === 'down' ? ' · link down' : silent ? ' · no frames' : '';
  if (stale) return { ageMs: age, stale, label: `STALE ${fmtDur(age)}${why}`, cls: 'stale' };
  if (!moving) return { ageMs: age, stale, label: `PAUSED · data age ${fmtDur(age)}`, cls: 'paused' };
  return { ageMs: age, stale, label: `${f.mode === 'live' ? 'LIVE' : 'REPLAY'} · ${fmtDur(age)} behind`, cls: 'ok' };
}
