import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { CARD_PIXELS_PER_UNIT, cardScale } from '@swf/presentation';
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
  await expect
    .poll(() => page.getByText('Drag a window by the band across its top').isVisible())
    .toBe(true);

  // Typing reaches the element natively, as on any page.
  await notes.click();
  await page.keyboard.press('Control+End');
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

it('draws each window as a flat card in the room, and moves one dragged by its title band round the room', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${server.url}/examples/browser-host/`);
  await page.waitForSelector('html[data-swf-example="ready"]', { timeout: 30_000 });

  const box = (selector: string) =>
    page.locator(selector).evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  // A window 3 units out in a view 120° across, drawn in full: its own size at the cards' pixels
  // a unit, times the scale for that distance and field of view.
  const unit = CARD_PIXELS_PER_UNIT * cardScale('full', 3, 120, false);
  for (const [id, heading] of [
    ['notes', -25],
    ['tips', 25],
  ] as const) {
    const card = await box(`[data-swf-layer="chrome"][data-swf-node="${id}-window"]`);
    // Upright and undistorted: the window's own 1.6 by 1.3, centred where its centre projects.
    expect(card.width).toBeCloseTo(1.6 * unit, 1);
    expect(card.height).toBeCloseTo(1.3 * unit, 1);
    expect(card.x + card.width / 2).toBeCloseTo(640 + (heading / 120) * 1280, 1);
    expect(card.y + card.height / 2).toBeCloseTo(360, 1);
    // The content fills the card below the title band, live and in place.
    const content = page.locator(`[data-swf-surface="${id}-view"]`);
    expect(await content.getAttribute('data-swf-mode')).toBe('native');
    expect(await content.getAttribute('data-swf-anchor')).toBe('exact');
    const slot = await box(`[data-swf-surface="${id}-view"]`);
    expect(slot.width).toBeCloseTo(card.width, 1);
    expect(slot.height).toBeCloseTo(1.0 * unit, 1);
    expect(slot.y + slot.height).toBeCloseTo(card.y + card.height, 1);
  }

  const notes = page.getByRole('textbox', { name: 'Notes' });
  await notes.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Kept.');
  const element = await notes.elementHandle();

  // Pressed on the title band, below the resize band along its top edge.
  const card = await box('[data-swf-layer="chrome"][data-swf-node="notes-window"]');
  const [x, y] = [card.x + card.width / 2, card.y + 24];
  expect(
    await page.evaluate(
      ([px, py]) =>
        document
          .elementFromPoint(px ?? 0, py ?? 0)
          ?.closest('[data-swf-handle],[data-swf-surface]') ?? null,
      [x, y],
    ),
  ).toBeNull();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 50, y - 34, { steps: 5 });
  await page.mouse.move(x + 100, y - 68, { steps: 5 });
  await page.mouse.up();

  // In the room: turned round the camera by the view's angle a pixel, raised 1/68 of a unit a
  // pixel, and still 3 units out along the floor.
  const position = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          swfExample: {
            workspace: {
              getState(): { nodes: Map<string, { transform: { position: number[] } }> };
            };
          };
        }
      ).swfExample.workspace
        .getState()
        .nodes.get('notes-window')?.transform.position,
  );
  const [px = 0, py = 0, pz = 0] = position ?? [];
  expect((Math.atan2(px, -pz) * 180) / Math.PI).toBeCloseTo(-25 + (100 * 120) / 1280, 6);
  expect(py).toBeCloseTo(1, 6);
  expect(Math.hypot(px, pz)).toBeCloseTo(3, 6);
  // The host's element went with it: the same element, what was typed still in it.
  expect(
    await element.evaluate(
      (e) => e.isConnected && e.closest('[data-swf-surface="notes-view"]') !== null,
    ),
  ).toBe(true);
  expect(await notes.inputValue()).toMatch(/Kept\.$/);

  await page.evaluate(() =>
    (globalThis as unknown as { swfExample: { dispose(): Promise<void> } }).swfExample.dispose(),
  );
  await page.close();
});
