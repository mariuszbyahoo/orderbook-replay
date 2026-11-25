/**
 * Manual-verification script, automated: serves dist/ under /p/orderbook-replay/, drives Chromium
 * and checks load, play, seek, speed change, keyboard controls and the stale indicator.
 * Saves screenshots to docs/. Exit code != 0 on any failed check.
 *
 *   npm run build && npm run e2e
 */
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { serve } from './serve';

interface Probe {
  ready: boolean;
  speed: number;
  frame: { now: number; playing: boolean; cursor: number; mode: string } | null;
  fresh: { stale: boolean; label: string };
  freeze(ms: number): void;
}
const probe = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as { __probe: Probe };
    const f = w.__probe.frame;
    return {
      ready: w.__probe.ready,
      speed: w.__probe.speed,
      now: f?.now ?? 0,
      playing: f?.playing ?? false,
      cursor: f?.cursor ?? 0,
      stale: w.__probe.fresh.stale,
      label: w.__probe.fresh.label,
    };
  });

const embeddedErrorsOk = (e: string[]): boolean => e.length === 0;

const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string): void => {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
};

const srv = await serve('dist', '/p/orderbook-replay/', 4175);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

try {
  await page.goto('http://127.0.0.1:4175/p/orderbook-replay/');
  await page.waitForFunction(() => (window as unknown as { __probe?: Probe }).__probe?.ready, null, {
    timeout: 60_000,
  });
  await page.waitForTimeout(300);
  const introOpen = await page.locator('dialog#help').evaluate((d) => (d as HTMLDialogElement).open);
  await page.keyboard.press('Escape');
  const introClosed = !(await page.locator('dialog#help').evaluate((d) => (d as HTMLDialogElement).open));
  check(
    'intro overlay on first load, dismissible (Esc)',
    introOpen && introClosed,
    `open=${introOpen}, closed after Esc=${introClosed}`,
  );
  const s0 = await probe(page);
  check('load', s0.ready && s0.now > 0, `ready, playhead ${new Date(s0.now).toISOString()}`);

  // play (keyboard: Space)
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
  const s1 = await probe(page);
  check(
    'play (Space)',
    s1.playing && s1.now > s0.now,
    `advanced ${((s1.now - s0.now) / 1000).toFixed(1)} s of data in 1.5 s wall at ${s1.speed}x`,
  );

  // speed change (keyboard: ])
  await page.keyboard.press(']');
  await page.waitForTimeout(100);
  const s2 = await probe(page);
  check('speed up (])', s2.speed > s1.speed, `${s1.speed}x -> ${s2.speed}x`);
  await page.selectOption('#speed', '50');
  await page.waitForTimeout(1000);
  const s2b = await probe(page);
  check('speed select', s2b.speed === 50, `select -> ${s2b.speed}x`);

  // pause + step
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  const s3 = await probe(page);
  await page.keyboard.press('.');
  await page.waitForTimeout(150);
  const s4 = await probe(page);
  check(
    'pause (Space) + step event (.)',
    !s3.playing && s4.cursor === s3.cursor + 1,
    `cursor ${s3.cursor} -> ${s4.cursor}`,
  );
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(150);
  const s5 = await probe(page);
  check('step 1 s (Shift+→)', Math.abs(s5.now - s4.now - 1000) < 1, `Δ ${s5.now - s4.now} ms`);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  const s6 = await probe(page);
  check('step back 100 ms (←)', Math.abs(s5.now - s6.now - 100) < 1, `Δ ${s6.now - s5.now} ms`);

  // seek via timeline click at 60 %
  const tl = await page.locator('#timeline').boundingBox();
  if (!tl) throw new Error('timeline missing');
  await page.mouse.click(tl.x + tl.width * 0.6, tl.y + tl.height / 2);
  await page.waitForTimeout(300);
  const s7 = await probe(page);
  check('seek (timeline click)', s7.now > s6.now + 60_000, `jumped to ${new Date(s7.now).toISOString()}`);
  await page.keyboard.press('Home');
  await page.waitForTimeout(200);
  const s8 = await probe(page);
  check('seek start (Home)', s8.now < s7.now, `back to ${new Date(s8.now).toISOString()}`);

  // screenshot 1: mid-session, playing, with history on screen
  await page.mouse.click(tl.x + tl.width * 0.55, tl.y + tl.height / 2);
  await page.selectOption('#speed', '10');
  await page.keyboard.press('Space');
  await page.waitForTimeout(2500);
  await mkdir('docs', { recursive: true });
  await page.screenshot({ path: 'docs/screenshot-replay.png' });

  // stale indicator: stall the engine worker for 3 s while playing
  await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe.freeze(3000));
  await page.waitForTimeout(1500);
  const s9 = await probe(page);
  const banner = await page.locator('#fresh').textContent();
  const bodyStale = await page.evaluate(() => document.body.classList.contains('is-stale'));
  check('stale indicator (worker stalled)', s9.stale && bodyStale && /STALE/.test(banner ?? ''), `banner "${banner}"`);
  await page.screenshot({ path: 'docs/screenshot-stale.png' });
  await page.waitForTimeout(2500);
  const s10 = await probe(page);
  check('recovers after stall', !s10.stale, `banner "${s10.label}"`);

  // keyboard help dialog
  await page.keyboard.press('?');
  const open = await page.locator('dialog#help').evaluate((d) => (d as HTMLDialogElement).open);
  check('help dialog (?)', open, 'opened');
  await page.locator('#helpClose').click(); // the button path (Esc is tested above)
  const closedByButton = !(await page.locator('dialog#help').evaluate((d) => (d as HTMLDialogElement).open));
  check('help dialog closes via its button', closedByButton, `closed=${closedByButton}`);

  // prefers-reduced-motion: the window pages in steps instead of scrolling every frame
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('Home');
  await page.selectOption('#speed', '5');
  if (!(await probe(page)).playing) await page.keyboard.press('Space');
  const t1s: number[] = [];
  for (let i = 0; i < 10; i++) {
    t1s.push(await page.evaluate(() => (window as unknown as { __probe: { view: { t1: number } } }).__probe.view.t1));
    await page.waitForTimeout(100);
  }
  const distinct = new Set(t1s).size;
  check(
    'reduced motion: view pages, not scrolls',
    distinct <= 2,
    `${distinct} distinct window positions over 1 s at 5x`,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // intro is remembered (localStorage) across reloads
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __probe?: Probe }).__probe?.ready, null, {
    timeout: 60_000,
  });
  const introAgain = await page.locator('dialog#help').evaluate((d) => (d as HTMLDialogElement).open);
  check('intro not shown again after dismissal', !introAgain, `open=${introAgain}`);

  // narrow screens get a clear note instead of a silently cramped layout
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const noteVisible = await page.locator('.narrow-note').isVisible();
  const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(
    '390 px: desktop note visible, no horizontal scroll',
    noteVisible && !hScroll,
    `note=${noteVisible}, hScroll=${hScroll}`,
  );
  await page.screenshot({ path: 'docs/screenshot-390.png', fullPage: false });
  await page.setViewportSize({ width: 1600, height: 1000 });

  check('no page errors', errors.length === 0, errors.join(' | ') || 'none');

  // Embedded like on MyHub: cross-origin parent (other port; a non-loopback parent would trip Chrome's local-network check), sandbox="allow-scripts allow-same-origin", fresh storage
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const host = await ctx2.newPage();
  const embedErrors: string[] = [];
  host.on('pageerror', (e) => embedErrors.push(e.message));
  host.on('console', (m) => m.type() === 'error' && embedErrors.push(m.text()));
  // a real loopback server for the parent page (Chrome's local-network check blocks synthetic parents)
  const parentSrv = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!doctype html><iframe src="http://127.0.0.1:4175/p/orderbook-replay/" title="demo" width="1300" height="800" ' +
        'sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>',
    );
  });
  await new Promise<void>((r) => parentSrv.listen(4180, '127.0.0.1', r));
  await host.goto('http://127.0.0.1:4180/');
  const fr = (await (await host.waitForSelector('iframe')).contentFrame())!;
  await fr.waitForLoadState('load');
  await fr.waitForFunction(() => (window as unknown as { __probe?: Probe }).__probe?.ready, null, { timeout: 60_000 });
  const embIntro = await fr.locator('dialog#help').evaluate((d) => (d as HTMLDialogElement).open);
  await fr.locator('#helpClose').click();
  const embClosed = !(await fr.locator('dialog#help').evaluate((d) => (d as HTMLDialogElement).open));
  await fr.locator('#bPlay').click();
  await host.waitForTimeout(1500);
  const embPlaying = await fr.evaluate(() => (window as unknown as { __probe: Probe }).__probe.frame?.playing ?? false);
  check(
    'embedded (cross-origin sandboxed iframe): intro, close button, play, no console errors',
    embIntro && embClosed && embPlaying && embeddedErrorsOk(embedErrors),
    `intro=${embIntro} closed=${embClosed} playing=${embPlaying} errors=${embedErrors.join(' | ') || 'none'}`,
  );
  await ctx2.close();
  parentSrv.close();
} catch (e) {
  check('e2e run', false, String(e));
} finally {
  await browser.close();
  srv.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
