import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import type { ViteDevServer } from 'vite';
import { createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Development (ENV-003): the dev server serves the application from its sources, with no
 * credentials or external services, and an edited module replaces the running application in
 * place. The server runs on a copy of the application, so the test edits nothing of the
 * repository's.
 */

const app = fileURLToPath(new URL('../..', import.meta.url));
const configFile = join(app, 'vite.config.mjs');
const packages = fileURLToPath(new URL('../../../../packages', import.meta.url));
let root = '';
let server: ViteDevServer;
let browser: Browser;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'swf-reference-dev-'));
  await cp(join(app, 'index.html'), join(root, 'index.html'));
  await cp(join(app, 'src'), join(root, 'src'), { recursive: true });
  server = await createServer({
    // The application's own configuration, rooted at the copy.
    configFile,
    root,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, packages] } },
  });
  await server.listen();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const noteText = (page: Page) =>
  page.locator('[data-reference-content] p').evaluateAll((ps) => ps.map((p) => p.textContent));

describe('the development server', () => {
  it('serves the application, and replaces it in place when a module is edited', async () => {
    const url = server.resolvedUrls?.local[0];
    if (url === undefined) {
      throw new Error('the dev server has no address');
    }
    const page = await browser.newPage({ viewport: { width: 1200, height: 500 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${url}?preset=seam`);
    await expect
      .poll(() => page.locator('[data-reference-content]').count(), { timeout: 15_000 })
      .toBe(4);
    // A mark on the page itself: a full reload would lose it.
    await page.evaluate(() => {
      (window as unknown as { mark: string }).mark = 'kept';
    });

    const messages = join(root, 'src', 'messages.ts');
    const source = await readFile(messages, 'utf8');
    const edited = source.replace(
      "'A native page element: select and type here.'",
      "'Edited while running.'",
    );
    expect(edited).not.toBe(source);
    await writeFile(messages, edited);

    await expect
      .poll(() => noteText(page), { timeout: 15_000 })
      .toEqual([
        'Edited while running.',
        'Edited while running.',
        'Edited while running.',
        'Edited while running.',
      ]);
    // The page was not reloaded, and the old application left nothing behind.
    expect(await page.evaluate(() => (window as unknown as { mark?: string }).mark)).toBe('kept');
    expect(await page.locator('[data-swf-viewport]').count()).toBe(1);
    expect(await page.locator('[data-reference-content]').count()).toBe(4);
    expect(errors).toEqual([]);
  });
});
