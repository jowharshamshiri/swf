import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The static build (ENV-006, NFR-014, NFR-027): one page that runs straight from the file, with
 * no server, no credentials and no network at all.
 */

const configFile = fileURLToPath(new URL('../../vite.config.mjs', import.meta.url));
let outDir = '';
let browser: Browser;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'swf-reference-'));
  await build({ configFile, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  await rm(outDir, { recursive: true, force: true });
});

/** Opens the built page offline, recording every request and every error it makes. */
async function open(search: string) {
  const context = await browser.newContext({
    offline: true,
    viewport: { width: 1200, height: 500 },
  });
  const page = await context.newPage();
  const page_url = `${pathToFileURL(join(outDir, 'index.html')).href}${search}`;
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (request.url() !== page_url) {
      requests.push(request.url());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  await page.goto(page_url);
  return { page, requests, errors, close: () => context.close() };
}

/** Waits until the view shows `count` of a selector. */
async function shows(page: Page, selector: string, count: (n: number) => boolean) {
  await expect
    .poll(async () => count(await page.locator(selector).count()), { timeout: 10_000 })
    .toBe(true);
}

describe('the static build', () => {
  it('is one self-contained page, loading nothing from anywhere', async () => {
    expect(await readdir(outDir)).toEqual(['index.html']);
    const html = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<(?:script|link|img|iframe|source)\b[^>]*\b(?:src|href)=/);
    expect(html).toContain('<script type="module">');
  });

  it('shows the sparse panorama from the file, offline, without a single request', async () => {
    const run = await open('');
    await shows(run.page, '[data-reference-content]', (n) => n === 3);
    await shows(run.page, '[data-swf-viewport]', (n) => n === 1);
    expect(run.requests).toEqual([]);
    expect(run.errors).toEqual([]);
    await run.close();
  });

  it('shows the seam scene on the geometry backend, offline, without a single request', async () => {
    const run = await open('?preset=seam&seed=7&backend=geometry');
    await shows(run.page, 'canvas', (n) => n > 0);
    await shows(run.page, '[data-reference-content]', (n) => n > 0);
    expect(run.requests).toEqual([]);
    expect(run.errors).toEqual([]);
    await run.close();
  });

  it('shows the dense scene, offline, without a single request', async () => {
    const run = await open('?preset=dense');
    await shows(run.page, '[data-reference-content]', (n) => n === 50);
    expect(run.requests).toEqual([]);
    expect(run.errors).toEqual([]);
    await run.close();
  });

  it('reports an invalid address setting by name', async () => {
    const run = await open('?preset=busy');
    await expect.poll(() => run.errors, { timeout: 10_000 }).toHaveLength(1);
    expect(run.errors[0]).toContain('preset: a preset must be one of empty, sparse, dense, seam');
    expect(run.requests).toEqual([]);
    await run.close();
  });
});
