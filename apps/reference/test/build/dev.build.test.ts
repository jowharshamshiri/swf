import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserType, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';
import type { ViteDevServer } from 'vite';
import { createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Development (ENV-003): the dev server serves the application from its sources, with no
 * credentials or external services, laid out as the build lays it out, and an edited module
 * replaces the running application in place. The server runs on a copy of the application, so
 * the test edits nothing of the repository's.
 */

const app = fileURLToPath(new URL('../..', import.meta.url));
const configFile = join(app, 'vite.config.mjs');
const repository = fileURLToPath(new URL('../../../..', import.meta.url));
/** The panorama as either backend presents it: the DOM backend's viewport, the geometry backend's composition. */
const PANORAMA = '[data-swf-viewport], [data-swf-composition]';
let root = '';
let server: ViteDevServer;
let browser: Browser;

beforeAll(async () => {
  // Inside the application's folder, so the copy resolves the packages the application installs.
  root = await mkdtemp(join(app, '.dev-test-'));
  await cp(join(app, 'index.html'), join(root, 'index.html'));
  await cp(join(app, 'src'), join(root, 'src'), { recursive: true });
  server = await createServer({
    // The application's own configuration, rooted at the copy.
    configFile,
    root,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repository] } },
  });
  await server.listen();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

/** The browsers the application is shown in. */
const engines: Record<string, BrowserType> = { chromium, firefox, webkit };

/** The address the dev server answers at. */
function address(): string {
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) {
    throw new Error('the dev server has no address');
  }
  return url;
}

const noteText = (page: Page) =>
  page.locator('[data-reference-content] p').evaluateAll((ps) => ps.map((p) => p.textContent));

describe('the development server', () => {
  // The kit lays out the body's first element as the window's whole height (its README: a host
  // mounts its application into the body's first element). Anything else in that place, such as
  // the page's module script, takes the window and pushes the application below it.
  for (const [name, engine] of Object.entries(engines)) {
    it(`shows the application filling the window in ${name}`, async () => {
      const shown = await engine.launch();
      try {
        const viewport = { width: 1200, height: 500 };
        const page = await shown.newPage({ viewport });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(address());
        await page.locator(`.wsb-application :is(${PANORAMA})`).waitFor({ timeout: 15_000 });
        const layout = await page.evaluate(() => {
          const application = document.querySelector('.wsb-application');
          if (application === null) {
            throw new Error('the page has no application');
          }
          // The element of the body's the application is mounted in.
          let mount: Element | null = application;
          while (mount !== null && mount.parentElement !== document.body) {
            mount = mount.parentElement;
          }
          const box = application.getBoundingClientRect();
          const centre = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
          return {
            mountedFirst: mount !== null && mount === document.body.firstElementChild,
            box: { x: box.x, y: box.y, width: box.width, height: box.height },
            centreIsApplication: centre !== null && application.contains(centre),
            scrollHeight: document.documentElement.scrollHeight,
          };
        });
        expect(layout).toEqual({
          mountedFirst: true,
          box: { x: 0, y: 0, ...viewport },
          centreIsApplication: true,
          scrollHeight: viewport.height,
        });
        expect(errors).toEqual([]);
      } finally {
        await shown.close();
      }
    });
  }

  it('serves the application, and replaces it in place when a module is edited', async () => {
    const url = address();
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
      "'A note: select it and type here.'",
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
    expect(await page.locator(PANORAMA).count()).toBe(1);
    expect(await page.locator('[data-reference-content]').count()).toBe(4);
    expect(errors).toEqual([]);
  });
});
