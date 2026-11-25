export interface Viewport {
  /** time range, exchange ms */
  t0: number;
  t1: number;
  /** price range, ticks */
  p0: number;
  p1: number;
}

/** Canvas sized to its CSS box at device pixel ratio. Returns true if it was resized. */
export function fitCanvas(c: HTMLCanvasElement, maxDpr = 2): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width === w && c.height === h) return false;
  c.width = w;
  c.height = h;
  return true;
}

export function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

export function ticks(lo: number, hi: number, target: number): number[] {
  if (!(hi > lo)) return [];
  const st = niceStep(hi - lo, target);
  const out: number[] = [];
  for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) out.push(v);
  return out;
}

const TIME_STEPS = [
  100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
];
export function timeTicks(t0: number, t1: number, target: number): number[] {
  const raw = (t1 - t0) / Math.max(1, target);
  const st = TIME_STEPS.find((s) => s >= raw) ?? 3_600_000;
  const out: number[] = [];
  for (let v = Math.ceil(t0 / st) * st; v <= t1; v += st) out.push(v);
  return out;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
/** UTC wall clock, always: exchange timestamps are UTC and the label says so. */
export function fmtTime(t: number, ms = false): string {
  const d = new Date(t);
  const s = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return ms ? `${s}.${pad(d.getUTCMilliseconds(), 3)}` : s;
}

export function fmtNum(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(ms)} ms`;
  if (a < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((a % 60_000) / 1000)} s`;
}

/** Stripe pattern used to mark asks / gaps / the unknown future without relying on colour. */
export function hatch(ctx: CanvasRenderingContext2D, color: string, size = 6, bg = 'transparent'): CanvasPattern {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(-1, size + 1);
  g.lineTo(size + 1, -1);
  g.moveTo(-1, 1);
  g.lineTo(1, -1);
  g.moveTo(size - 1, size + 1);
  g.lineTo(size + 1, size - 1);
  g.stroke();
  return ctx.createPattern(c, 'repeat')!;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';
