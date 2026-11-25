import { describe, expect, it } from 'vitest';
import { Ring, quantile, summarize } from '../src/ui/perf';

describe('perf stats', () => {
  it('computes interpolated quantiles', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.95)).toBeCloseTo(9.5);
  });
  it('ring keeps only the last N samples', () => {
    const r = new Ring(3);
    for (const v of [1, 2, 3, 4, 5]) r.push(v);
    const s = summarize(r.values());
    expect(s.n).toBe(3);
    expect(s.max).toBe(5);
    expect(s.p50).toBe(4);
  });
});
