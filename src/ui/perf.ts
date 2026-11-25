/** Rolling frame statistics. Fixed-size ring, percentiles computed on demand. */
export class Ring {
  private a: Float64Array;
  private i = 0;
  n = 0;
  constructor(readonly size: number) {
    this.a = new Float64Array(size);
  }
  push(v: number): void {
    this.a[this.i] = v;
    this.i = (this.i + 1) % this.size;
    if (this.n < this.size) this.n++;
  }
  values(): Float64Array {
    return this.a.slice(0, this.n);
  }
  clear(): void {
    this.n = 0;
    this.i = 0;
  }
}

export function quantile(sorted: ArrayLike<number>, q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function summarize(v: Float64Array): Summary {
  const s = Float64Array.from(v).sort();
  let sum = 0;
  for (const x of s) sum += x;
  return {
    n: s.length,
    p50: quantile(s, 0.5),
    p95: quantile(s, 0.95),
    p99: quantile(s, 0.99),
    max: s.length ? s[s.length - 1]! : NaN,
    mean: s.length ? sum / s.length : NaN,
  };
}
