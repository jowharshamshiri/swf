import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_FEATURES } from '../../src/features.js';
import { planPreset, presetIssue } from '../../src/presets.js';

/**
 * The static build (ENV-006, NFR-014, NFR-027): one page that runs straight from the file, with
 * no server, no credentials and no network at all. Production builds leave the debug overlay out;
 * staging builds carry it (ENV-005). Everyday builds leave the experiment panel out too, keeping
 * every capability on and the everyday controls.
 */

const configFile = fileURLToPath(new URL('../../vite.config.mjs', import.meta.url));
/** Said only by the diagnostics package: present in a bundle exactly when the package is. */
const DIAGNOSTICS_ONLY = 'errorCapacity must be a whole number of at least 1';
/** Said only by the developer tools' failure simulation. */
const DEVTOOLS_ONLY = 'reference.simulated.slow/1';
/** Named only by the experiment panel: its list's handle. */
const EXPERIMENTS_ONLY = 'page.experiments.run';

const builds = { production: '', staging: '', everyday: '' };
let browser: Browser;

beforeAll(async () => {
  for (const mode of ['production', 'staging', 'everyday'] as const) {
    builds[mode] = await mkdtemp(join(tmpdir(), `swf-reference-${mode}-`));
    await build({
      configFile,
      mode,
      logLevel: 'silent',
      build: { outDir: builds[mode], emptyOutDir: true },
    });
  }
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  for (const dir of Object.values(builds)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** The automation driver the page installs, as a scenario reaches it. */
interface Driver {
  has(handle: string): boolean;
}

/** Opens a built page offline, recording every request and every error it makes. */
async function open(search: string, mode: keyof typeof builds = 'production') {
  const context = await browser.newContext({
    offline: true,
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const pageUrl = `${pathToFileURL(join(builds[mode], 'index.html')).href}${search}`;
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (request.url() !== pageUrl) {
      requests.push(request.url());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  await page.goto(pageUrl);
  const has = (handle: string) =>
    page.evaluate(
      (h) => (window as unknown as { wsbAutomation: Driver }).wsbAutomation.has(h),
      handle,
    );
  return { page, requests, errors, has, close: () => context.close() };
}

/** Waits until the page shows `count` of a selector. */
async function shows(page: Page, selector: string, count: (n: number) => boolean) {
  await expect
    .poll(async () => count(await page.locator(selector).count()), { timeout: 10_000 })
    .toBe(true);
}

describe('the static build', () => {
  it('is one self-contained page, loading nothing from anywhere', async () => {
    for (const dir of Object.values(builds)) {
      expect(await readdir(dir)).toEqual(['index.html']);
      const html = await readFile(join(dir, 'index.html'), 'utf8');
      expect(html).not.toMatch(/<(?:script|link|img|iframe|source)\b[^>]*\b(?:src|href)=/);
      expect(html).toContain('<script type="module">');
    }
  });

  it('shows the shell and the sparse panorama from the file, offline, without a single request', async () => {
    const run = await open('?preset=sparse');
    await shows(run.page, '[data-reference-content]', (n) => n === 3);
    await shows(run.page, '[data-swf-viewport]', (n) => n === 1);
    expect(await run.has('page.scene.preset')).toBe(true);
    expect(await run.has('editor.actions.commands')).toBe(true);
    // The kit's faces are in the page itself.
    expect(await run.page.evaluate(() => document.fonts.check('16px "Inter Variable"'))).toBe(true);
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
    // Semantic depth shows a note's content only nearer than its full band; the rest are
    // represented, their content bound but not shown.
    const near = planPreset('dense', 1).filter(
      (w) => w.content === 'note' && w.distance < DEFAULT_FEATURES.depth.full,
    ).length;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(50);
    await shows(run.page, '[data-reference-content]', (n) => n === near);
    expect(run.requests).toEqual([]);
    expect(run.errors).toEqual([]);
    await run.close();
  });

  it('explains how to add windows when the workspace is empty (UX-009)', async () => {
    const run = await open('?preset=empty');
    await shows(run.page, 'text=No windows yet', (n) => n === 1);
    expect(await run.has('page.panorama.load')).toBe(true);
    expect(run.requests).toEqual([]);
    await run.close();
  });

  it('says which address setting is invalid, by name, and starts nothing', async () => {
    const run = await open('?preset=busy');
    await shows(
      run.page,
      `text=The address names an invalid preset: ${String(presetIssue('busy'))}`,
      (n) => n === 1,
    );
    expect(await run.page.locator('[data-swf-viewport]').count()).toBe(0);
    expect(run.errors).toEqual([]);
    expect(run.requests).toEqual([]);
    await run.close();
  });
});

describe('the debug overlay (ENV-005)', () => {
  it('is left out of production builds, diagnostics package, developer tools and all', async () => {
    const html = await readFile(join(builds.production, 'index.html'), 'utf8');
    expect(html).not.toContain(DIAGNOSTICS_ONLY);
    expect(html).not.toContain(DEVTOOLS_ONLY);
    const run = await open('?preset=sparse');
    await shows(run.page, '[data-swf-viewport]', (n) => n === 1);
    expect(await run.has('worktree.view#inspector')).toBe(true);
    expect(await run.has('worktree.view#developer')).toBe(false);
    await run.close();
  });

  it('is carried by staging builds, reading the running presentation', async () => {
    const html = await readFile(join(builds.staging, 'index.html'), 'utf8');
    expect(html).toContain(DIAGNOSTICS_ONLY);
    expect(html).toContain(DEVTOOLS_ONLY);
    const run = await open('?preset=sparse', 'staging');
    await shows(run.page, '[data-swf-viewport]', (n) => n === 1);
    expect(await run.has('worktree.view#developer')).toBe(true);
    await run.page.click('[data-wsb="worktree.view#developer"]');
    await shows(run.page, '[data-wsb="page.developer"]', (n) => n === 1);
    await shows(run.page, 'text=Show the debug overlay', (n) => n === 1);
    expect(run.requests).toEqual([]);
    expect(run.errors).toEqual([]);
    await run.close();
  });
});

describe('the experiment panel (brief §5)', () => {
  it('is carried by production builds', async () => {
    const html = await readFile(join(builds.production, 'index.html'), 'utf8');
    expect(html).toContain(EXPERIMENTS_ONLY);
    const run = await open('?preset=studio');
    await shows(run.page, '[data-swf-viewport]', (n) => n === 1);
    expect(await run.has('workshop.view#experiments')).toBe(true);
    await run.page.click('[data-wsb="workshop.view#experiments"]');
    await shows(run.page, '[data-wsb="page.experiments.list"]', (n) => n === 1);
    expect(run.errors).toEqual([]);
    await run.close();
  });

  it('is left out of everyday builds, with every capability on and the everyday controls in place', async () => {
    const html = await readFile(join(builds.everyday, 'index.html'), 'utf8');
    expect(html).not.toContain(EXPERIMENTS_ONLY);
    expect(html).not.toContain(DIAGNOSTICS_ONLY);
    expect(html).not.toContain(DEVTOOLS_ONLY);
    const run = await open('?preset=studio', 'everyday');
    await shows(run.page, '[data-swf-viewport]', (n) => n === 1);
    expect(await run.has('workshop.view#experiments')).toBe(false);
    expect(await run.has('worktree.view#developer')).toBe(false);
    for (const handle of [
      'editor.actions.mode',
      'editor.actions.navigation',
      'editor.actions.commands',
      'page.view.fov',
      'page.view.heading',
      'page.radar',
      'workshop.view#workspaces',
    ]) {
      expect(await run.has(handle), handle).toBe(true);
    }
    // Every capability at work: the map and focus offered, the farther windows represented.
    const switcher = await run.page.locator('[data-wsb="editor.actions.mode"]').textContent();
    expect(switcher).toContain('Map');
    expect(switcher).toContain('Focus');
    expect(run.requests).toEqual([]);
    expect(run.errors).toEqual([]);
    await run.close();
  });

  it('refuses a build mode it does not know, naming it', async () => {
    await expect(
      build({ configFile, mode: 'nightly', logLevel: 'silent', build: { write: false } }),
    ).rejects.toThrow('the reference application has no build mode "nightly"');
  });
});
