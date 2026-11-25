/**
 * Benchmark: build must exist (npm run build). Serves dist/, opens Chromium, runs the app's
 * ?bench=N mode (100x replay, deterministic start, wraps at end) and writes perf/results.json.
 *
 *   npm run bench -- [--seconds 60] [--headless] [--width 1600 --height 1000]
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { serve } from './serve';

const { values } = parseArgs({
  options: {
    seconds: { type: 'string', default: '60' },
    headless: { type: 'boolean', default: false },
    width: { type: 'string', default: '1600' },
    height: { type: 'string', default: '1000' },
    out: { type: 'string', default: 'perf/results.json' },
    dpr: { type: 'string', default: '2' },
  },
});
const seconds = Number(values.seconds);
const srv = await serve('dist', '/p/orderbook-replay/', 4174);
const browser = await chromium.launch({ headless: values.headless });
const page = await browser.newPage({
  viewport: { width: Number(values.width), height: Number(values.height) },
  deviceScaleFactor: Number(values.dpr),
});
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:4174/p/orderbook-replay/?bench=${seconds}`);
console.error(`running ${seconds}s benchmark (${values.headless ? 'headless' : 'headed'})…`);
await page.waitForFunction(() => (window as unknown as { __bench?: unknown }).__bench, null, {
  timeout: (seconds + 90) * 1000,
  polling: 1000,
});
const result = await page.evaluate(() => (window as unknown as { __bench: unknown }).__bench);
let macos = '';
try {
  macos = execSync('sw_vers -productVersion').toString().trim();
} catch {
  /* not macOS */
}
let hw = '';
try {
  hw = execSync('sysctl -n machdep.cpu.brand_string').toString().trim();
} catch {
  /* not macOS */
}
const doc = {
  measuredAt: new Date().toISOString(),
  device: {
    cpu: hw || cpus()[0]?.model,
    cores: cpus().length,
    memGB: Math.round(totalmem() / 2 ** 30),
    os: `macOS ${macos} (Darwin ${release()})`,
  },
  browser: { name: 'Chromium (Playwright)', version: browser.version(), mode: values.headless ? 'headless' : 'headed' },
  errors,
  result,
};
await mkdir('perf', { recursive: true });
await writeFile(values.out!, JSON.stringify(doc, null, 2) + '\n');
console.log(JSON.stringify(doc, null, 2));
await browser.close();
srv.close();
