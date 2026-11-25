/**
 * Columnar, append-only event store. Records are parsed once into typed arrays so the replay
 * loop never touches strings or allocates.
 */
import type { MetaRec, Rec } from './format';
import { priceScale, type PriceScale } from './orderbook';

export const EV_SNAP = 0;
export const EV_DEPTH = 1;
export const EV_TRADE = 2;
export const EV_GAP = 3;

class GrowF64 {
  a: Float64Array;
  n = 0;
  constructor(cap = 1 << 12) {
    this.a = new Float64Array(cap);
  }
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

class GrowU8 {
  a: Uint8Array;
  n = 0;
  constructor(cap = 1 << 12) {
    this.a = new Uint8Array(cap);
  }
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Uint8Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

/**
 * Event i:
 *   kind[i], time[i] (exchange ms, clamped monotonic), recv[i] (local receive ms)
 *   U[i], u[i]           depth: update id range; snap: U = u = lastUpdateId; trade: u = trade id
 *   lv0[i]               first level index; levels lv0..lv0+nb-1 are bids, then na asks
 *   nb[i], na[i]         trade: nb = 1 if aggressor BUY, na = 1 if aggressor SELL (1 level)
 */
export class Session {
  meta: MetaRec | null = null;
  scale: PriceScale = priceScale('0.01');
  private _kind = new GrowU8();
  private _time = new GrowF64();
  private _recv = new GrowF64();
  private _U = new GrowF64();
  private _u = new GrowF64();
  private _lv0 = new GrowF64();
  private _nb = new GrowF64();
  private _na = new GrowF64();
  private _lvT = new GrowF64(1 << 16);
  private _lvQ = new GrowF64(1 << 16);
  private lastTime = -Infinity;
  /** count of events whose exchange time went backwards and was clamped */
  clamped = 0;

  get length(): number {
    return this._kind.n;
  }
  get kind(): Uint8Array {
    return this._kind.a;
  }
  get time(): Float64Array {
    return this._time.a;
  }
  get recv(): Float64Array {
    return this._recv.a;
  }
  get U(): Float64Array {
    return this._U.a;
  }
  get u(): Float64Array {
    return this._u.a;
  }
  get lv0(): Float64Array {
    return this._lv0.a;
  }
  get nb(): Float64Array {
    return this._nb.a;
  }
  get na(): Float64Array {
    return this._na.a;
  }
  get lvTicks(): Float64Array {
    return this._lvT.a;
  }
  get lvQty(): Float64Array {
    return this._lvQ.a;
  }
  get levelCount(): number {
    return this._lvT.n;
  }

  get startTime(): number {
    return this.length ? this.time[0]! : 0;
  }
  get endTime(): number {
    return this.length ? this.time[this.length - 1]! : 0;
  }

  /** Optional price filter [lo, hi] in ticks applied at ingest (used for the trimmed sample). */
  band: [number, number] | null = null;

  add(r: Rec): void {
    switch (r.k) {
      case 'meta':
        this.meta = r;
        this.scale = priceScale(r.tickSize);
        if (r.band) this.band = r.band;
        return;
      case 'snap':
        this.push(EV_SNAP, r.E, r.t, r.id, r.id, r.b, r.a);
        return;
      case 'depth':
        this.push(EV_DEPTH, r.E, r.t, r.U, r.u, r.b, r.a);
        return;
      case 'trade': {
        const lv = [[r.p, r.q]] as const;
        // m = buyer is maker -> aggressor is the seller
        this.push(EV_TRADE, r.T, r.t, r.id, r.id, r.m ? [] : lv, r.m ? lv : []);
        return;
      }
      case 'gap':
        this.push(EV_GAP, Math.max(this.lastTime, r.t), r.t, 0, 0, [], []);
        return;
    }
  }

  private push(
    kind: number,
    t: number,
    recv: number,
    U: number,
    u: number,
    b: readonly (readonly [string, string])[],
    a: readonly (readonly [string, string])[],
  ): void {
    if (t < this.lastTime) {
      this.clamped++;
      t = this.lastTime;
    }
    this.lastTime = t;
    this._kind.push(kind);
    this._time.push(t);
    this._recv.push(recv);
    this._U.push(U);
    this._u.push(u);
    this._lv0.push(this._lvT.n);
    const band = kind === EV_TRADE ? null : this.band;
    let nb = 0;
    for (const [p, q] of b) {
      const tk = this.scale.toTicks(p);
      if (band && (tk < band[0] || tk > band[1])) continue;
      this._lvT.push(tk);
      this._lvQ.push(Number(q));
      nb++;
    }
    let na = 0;
    for (const [p, q] of a) {
      const tk = this.scale.toTicks(p);
      if (band && (tk < band[0] || tk > band[1])) continue;
      this._lvT.push(tk);
      this._lvQ.push(Number(q));
      na++;
    }
    this._nb.push(nb);
    this._na.push(na);
  }

  /** First event index with time > t (binary search). */
  upperBound(t: number): number {
    let lo = 0;
    let hi = this.length;
    const tm = this.time;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (tm[m]! <= t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
}

/** Parse a gzip'd JSONL stream (browser or Node >= 18) into a Session. */
export async function loadSession(
  body: ReadableStream<Uint8Array>,
  onProgress?: (lines: number) => void,
): Promise<Session> {
  const s = new Session();
  const text = body
    .pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    .pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>);
  const reader = text.getReader();
  let rest = '';
  let lines = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += value;
    let nl: number;
    let start = 0;
    while ((nl = rest.indexOf('\n', start)) !== -1) {
      const line = rest.slice(start, nl);
      start = nl + 1;
      if (line) {
        s.add(JSON.parse(line) as Rec);
        if (++lines % 5000 === 0) onProgress?.(lines);
      }
    }
    rest = rest.slice(start);
  }
  if (rest.trim()) s.add(JSON.parse(rest) as Rec);
  return s;
}
