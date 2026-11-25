/**
 * Records docs/demo.gif from the production build: play -> speed change -> seek on the scrubber ->
 * live mode -> stale indicator (engine worker deliberately stalled for 3 s).
 * Needs ffmpeg on PATH.   npm run build && npx tsx scripts/record-gif.ts
 */
import { chromium, type Page } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from './serve';

const W = 1280;
const H = 800;
const dir = await mkdtemp(join(tmpdir(), 'obr-gif-'));
const srv = await serve('dist', '/p/orderbook-replay/', 4177);
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir, size: { width: W, height: H } },
});
const page: Page = await ctx.newPage();
// reduced-motion mode pages the time window instead of scrolling it every frame: same content, and
// GIF's frame-difference compression keeps the file under ~8 MB
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto('http://127.0.0.1:4177/p/orderbook-replay/?intro=0');
await page.waitForFunction(() => (window as unknown as { __probe: { ready: boolean } }).__probe.ready);
const tl = (await page.locator('#timeline').boundingBox())!;
// start mid-session so the heatmap has history on screen
await page.mouse.click(tl.x + tl.width * 0.3, tl.y + tl.height / 2);
await page.waitForTimeout(800);
await page.keyboard.press('Space'); // play at 10x
await page.waitForTimeout(3300);
await page.selectOption('#speed', '50'); // speed change
await page.waitForTimeout(3300);
await page.mouse.click(tl.x + tl.width * 0.7, tl.y + tl.height / 2); // seek on the scrubber
await page.waitForTimeout(3300);
await page.keyboard.press('l'); // live mode
await page.waitForFunction(
  () =>
    (window as unknown as { __probe: { frame: { mode: string; valid: boolean } | null } }).__probe.frame?.valid ===
    true,
  null,
  { timeout: 30_000 },
);
await page.waitForTimeout(3300);
await page.evaluate(() => (window as unknown as { __probe: { freeze(ms: number): void } }).__probe.freeze(3000));
await page.waitForTimeout(5000); // STALE, then recovery
const video = page.video()!;
await ctx.close();
const webm = await video.path();
await browser.close();
srv.close();

const out = 'docs/demo.gif';
const keep = process.env.GIF_KEEP_WEBM; // optional: copy the raw capture for tuning
if (keep) execFileSync('cp', [webm, keep]);
const palette = join(dir, 'palette.png');
const filters = `fps=${process.env.GIF_FPS ?? 12},scale=${process.env.GIF_WIDTH ?? 960}:-1:flags=lanczos`;
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  '-i',
  webm,
  '-vf',
  `${filters},palettegen=max_colors=${process.env.GIF_COLORS ?? 32}:stats_mode=diff`,
  palette,
]);
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  '-i',
  webm,
  '-i',
  palette,
  '-lavfi',
  `${filters} [x]; [x][1:v] paletteuse=dither=none:diff_mode=rectangle`,
  out,
]);
const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out])
  .toString()
  .trim();
console.log(`${out}: ${((await stat(out)).size / 1e6).toFixed(2)} MB, ${Number(dur).toFixed(1)} s`);
await rm(dir, { recursive: true, force: true });
