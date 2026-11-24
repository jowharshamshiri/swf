import process from 'node:process';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import nodeConfig from './vitest.config.mjs';

// Browser tests run in real browsers through Playwright.
// SWF_BROWSERS picks them (comma-separated; default all three: chromium, firefox, webkit).
// SWF_CHROMIUM_CHANNEL runs chromium as an installed browser instead of Playwright's own build,
// for example `chrome` for an installed Google Chrome.
const KNOWN = ['chromium', 'firefox', 'webkit'];
const browsers = (process.env.SWF_BROWSERS ?? KNOWN.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');
const unknown = browsers.find((name) => !KNOWN.includes(name));
if (unknown !== undefined || browsers.length === 0) {
  throw new Error(
    `SWF_BROWSERS must list some of ${KNOWN.join(', ')} (got "${String(process.env.SWF_BROWSERS)}")`,
  );
}
const channel = process.env.SWF_CHROMIUM_CHANNEL;

/**
 * Moves, presses and releases the real mouse at a point of the test frame, so the browser
 * produces genuine (trusted) pointer events.
 */
async function mouse(ctx, action, x, y, modifiers = []) {
  const frame = await ctx.frame();
  const element = await frame.frameElement();
  const box = await element.boundingBox();
  if (box === null) {
    throw new Error('the test frame has no box');
  }
  for (const key of modifiers) {
    await ctx.page.keyboard.down(key);
  }
  await ctx.page.mouse.move(box.x + x, box.y + y);
  if (action === 'down') {
    await ctx.page.mouse.down();
  } else if (action === 'up') {
    await ctx.page.mouse.up();
  }
  for (const key of modifiers) {
    await ctx.page.keyboard.up(key);
  }
}

export default defineConfig({
  resolve: nodeConfig.resolve,
  test: {
    include: ['packages/*/test/**/*.browser.test.ts', 'apps/*/test/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      // Room for an 800 × 400 view and more.
      viewport: { width: 1280, height: 900 },
      provider: playwright(),
      commands: { mouse },
      instances: browsers.map((browser) =>
        browser === 'chromium' && channel !== undefined && channel !== ''
          ? { browser, provider: playwright({ launchOptions: { channel } }) }
          : { browser },
      ),
    },
  },
});
