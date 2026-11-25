import { describe, expect, it } from 'vitest';
import { freshness } from '../src/ui/freshness';

const base = {
  mode: 'live' as const,
  playing: true,
  speed: 1,
  now: 10_000,
  lastEventT: 9_900,
  sentAt: 1000,
  link: 'ok' as const,
  valid: true,
};

describe('freshness', () => {
  it('live and fresh', () => {
    const f = freshness(base, 1010);
    expect(f.stale).toBe(false);
    expect(f.ageMs).toBeCloseTo(110);
    expect(f.label).toMatch(/^LIVE/);
  });
  it('live: last event too old -> stale', () => {
    expect(freshness({ ...base, lastEventT: 7_000 }, 1000).stale).toBe(true);
  });
  it('live: worker silent -> stale even if last frame looked fresh', () => {
    const f = freshness(base, 1000 + 2000);
    expect(f.stale).toBe(true);
    expect(f.label).toContain('no frames');
  });
  it('link down / invalid book -> stale', () => {
    expect(freshness({ ...base, link: 'down' }, 1000).label).toContain('link down');
    expect(freshness({ ...base, valid: false }, 1000).label).toContain('book invalid');
  });
  it('replay: wall delay is scaled by speed', () => {
    const r = { ...base, mode: 'replay' as const, speed: 100, link: 'n/a' as const, lastEventT: 10_000 };
    expect(freshness(r, 1000 + 10).ageMs).toBe(1000);
    expect(freshness(r, 1000 + 20).stale).toBe(true);
  });
  it('replay paused is not stale and says so', () => {
    const r = { ...base, mode: 'replay' as const, playing: false, link: 'n/a' as const };
    const f = freshness(r, 1_000_000);
    expect(f.stale).toBe(false);
    expect(f.label).toMatch(/^PAUSED/);
  });
});
