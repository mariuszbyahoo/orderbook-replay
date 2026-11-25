/**
 * Colour-blind-safe palette (Okabe & Ito, 2008): blue vs orange stay distinct under protan,
 * deutan and tritan simulation. Colour is never the only channel: bids/asks also differ by
 * position (below/above mid), marker shape (▲ buy / ▼ sell) and fill pattern (solid / hatched).
 */
export const C = {
  bg: '#0b0e14',
  panel: '#11151d',
  grid: '#1e2430',
  text: '#d6dae3',
  dim: '#7d8596',
  bid: '#56b4e9', // sky blue
  bidStrong: '#0072b2',
  ask: '#e69f00', // orange
  askStrong: '#d55e00',
  mid: '#f0f0f0',
  decision: '#cc79a7', // reddish purple
  stale: '#f0e442', // yellow
  gap: '#d55e00',
} as const;

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;

function ramp(stops: RGB[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(x));
    const f = x - k;
    const a = stops[k]!;
    const b = stops[k + 1]!;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c]! + (b[c]! - a[c]!) * f;
  }
  return lut;
}

const BG = hex(C.bg);
export const BID_LUT = ramp([BG, [8, 48, 92], hex('#0072b2'), hex('#56b4e9'), [225, 245, 255]]);
export const ASK_LUT = ramp([BG, [80, 40, 0], hex('#d55e00'), hex('#e69f00'), [255, 240, 200]]);

/**
 * Column-major Uint8 rasters (col * rows + row, row 0 = lowest price) -> RGBA image with the
 * highest price on top. Cells with both sides (the bin containing the spread) are summed.
 */
export function rasterToRGBA(
  bid: Uint8Array,
  ask: Uint8Array,
  ncols: number,
  rows: number,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(ncols * rows * 4);
  for (let c = 0; c < ncols; c++) {
    const base = c * rows;
    for (let r = 0; r < rows; r++) {
      const vb = bid[base + r]!;
      const va = ask[base + r]!;
      const o = ((rows - 1 - r) * ncols + c) * 4;
      if (vb && va) {
        for (let k = 0; k < 3; k++) out[o + k] = BID_LUT[vb * 3 + k]! + ASK_LUT[va * 3 + k]! - BG[k]!;
      } else if (vb) {
        out[o] = BID_LUT[vb * 3]!;
        out[o + 1] = BID_LUT[vb * 3 + 1]!;
        out[o + 2] = BID_LUT[vb * 3 + 2]!;
      } else if (va) {
        out[o] = ASK_LUT[va * 3]!;
        out[o + 1] = ASK_LUT[va * 3 + 1]!;
        out[o + 2] = ASK_LUT[va * 3 + 2]!;
      } else {
        out[o] = BG[0];
        out[o + 1] = BG[1];
        out[o + 2] = BG[2];
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
