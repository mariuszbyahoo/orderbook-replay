/**
 * Trim a recording into the committed offline sample.
 *
 *   npm run sample -- --in data/session.jsonl.gz --out public/data/sample.jsonl.gz [--pad 0.005] [--minutes N]
 *
 * Keeps price levels inside a FIXED band [minTrade - pad, maxTrade + pad] for the whole session.
 * Because diffs carry absolute quantities, reconstruction inside a fixed band is exact; levels
 * outside it are simply absent. Depth records keep their U/u even when no level survives, so
 * continuity checks still run on every event. Trailing zeros are stripped from numbers.
 */
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { Rec } from '../src/engine/format';
import { priceScale } from '../src/engine/orderbook';

const { values } = parseArgs({
  options: {
    in: { type: 'string', default: 'data/session.jsonl.gz' },
    out: { type: 'string', default: 'public/data/sample.jsonl.gz' },
    pad: { type: 'string', default: '0.005' },
    minutes: { type: 'string' },
  },
});

async function* records(path: string): AsyncGenerator<Rec> {
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield JSON.parse(line) as Rec;
}

const strip = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

// pass 1: traded price range and time limit
let lo = Infinity;
let hi = -Infinity;
let t0 = 0;
const limitMs = values.minutes ? Number(values.minutes) * 60_000 : Infinity;
for await (const r of records(values.in!)) {
  if (r.k === 'meta') t0 = r.startedAt;
  if (r.k !== 'trade' || r.t - t0 > limitMs) continue;
  const p = Number(r.p);
  lo = Math.min(lo, p);
  hi = Math.max(hi, p);
}
const pad = ((lo + hi) / 2) * Number(values.pad);
const bandLo = lo - pad;
const bandHi = hi + pad;
console.error(`traded ${lo}..${hi}; band ${bandLo.toFixed(2)}..${bandHi.toFixed(2)}`);

// pass 2: filter
const gz = createGzip({ level: 9 });
const out = createWriteStream(values.out!);
gz.pipe(out);
let kept = 0;
let dropped = 0;
let n = 0;
const keep = (lv: [string, string][]): [string, string][] => {
  const res: [string, string][] = [];
  for (const [p, q] of lv) {
    const v = Number(p);
    if (v >= bandLo && v <= bandHi) {
      res.push([strip(p), strip(q)]);
      kept++;
    } else dropped++;
  }
  return res;
};
for await (const r of records(values.in!)) {
  if (r.k !== 'meta' && r.t - t0 > limitMs) break;
  if (r.k === 'meta') {
    const sc = priceScale(r.tickSize);
    const band: [number, number] = [sc.toTicks(bandLo.toFixed(sc.decimals)), sc.toTicks(bandHi.toFixed(sc.decimals))];
    const note = `Trimmed sample: price levels outside a fixed band of traded range ±${(Number(values.pad) * 100).toFixed(2)}% removed.`;
    gz.write(JSON.stringify({ ...r, band, note }) + '\n');
  } else if (r.k === 'snap') gz.write(JSON.stringify({ ...r, b: keep(r.b), a: keep(r.a) }) + '\n');
  else if (r.k === 'depth') gz.write(JSON.stringify({ ...r, b: keep(r.b), a: keep(r.a) }) + '\n');
  else if (r.k === 'trade') gz.write(JSON.stringify({ ...r, p: strip(r.p), q: strip(r.q) }) + '\n');
  else gz.write(JSON.stringify(r) + '\n');
  n++;
}
gz.end();
await new Promise((res) => out.on('close', res));
const size = statSync(values.out!).size;
console.error(`${n} records, levels kept ${kept}, dropped ${dropped}; ${(size / 1e6).toFixed(2)} MB -> ${values.out}`);
