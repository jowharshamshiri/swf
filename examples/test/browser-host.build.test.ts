import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { serve } from '../browser-host/serve.mjs';

/**
 * The browser host example as a browser loads it: the built packages (npm run build:packages)
 * through an import map, with no bundler (FR-183, ENV-008).
 */

let browser: Browser;
let server: { url: string; close(): Promise<unknown> };

beforeAll(async () => {
  server = await serve(0);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  await server.close();
});

it('presents the host’s own elements, which stay natively interactive', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => requests.push(request.url()));

  await page.goto(`${server.url}/examples/browser-host/`);
  await page.waitForSelector('html[data-swf-example="ready"]', { timeout: 30_000 });

  // Both windows' content is live in the view: the page's own elements, placed by the backend.
  const notes = page.getByRole('textbox', { name: 'Notes' });
  await expect.poll(() => notes.isVisible()).toBe(true);
  await expect.poll(() => page.getByText('Drag a window by its frame').isVisible()).toBe(true);

  // Typing reaches the element natively, as on any page.
  await notes.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  expect(await notes.inputValue()).toMatch(/Typed\.$/);

  // Every module came from the repository, loaded by the browser itself.
  expect(errors).toEqual([]);
  expect(requests.every((url) => url.startsWith(server.url))).toBe(true);
  expect(requests.some((url) => url.endsWith('/packages/core/dist/index.js'))).toBe(true);

  await page.evaluate(() =>
    (globalThis as unknown as { swfExample: { dispose(): Promise<void> } }).swfExample.dispose(),
  );
  await page.close();
});
