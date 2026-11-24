import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { playwright } from '@vitest/browser-playwright';

/**
 * What the browser suites share: which browsers they run in, and the commands they call on the
 * server through Playwright (real input, the browser's own heap where it reports one, and the
 * environment a run measured in).
 */

const KNOWN = ['chromium', 'firefox', 'webkit'];

/**
 * Whether the browsers run without a window: SWF_HEADED=1 gives them one (a browser may composite
 * with the GPU only then, as Firefox does), 0 or unset runs them headless.
 */
export function headless(env = process.env) {
  const value = env.SWF_HEADED ?? '0';
  if (value !== '0' && value !== '1') {
    throw new Error(`SWF_HEADED must be 0 or 1 (got "${value}")`);
  }
  return value === '0';
}

/**
 * The browsers a run uses, as Vitest instances. SWF_BROWSERS picks them (comma-separated; default
 * all three: chromium, firefox, webkit). Each runs Playwright's own build unless a channel names an
 * installed stable browser: SWF_CHROMIUM_CHANNEL (`chrome` for Google Chrome, `msedge`) and
 * SWF_FIREFOX_CHANNEL (`moz-firefox` for Mozilla Firefox, driven over WebDriver BiDi).
 */
export function browserInstances(env = process.env) {
  const browsers = (env.SWF_BROWSERS ?? KNOWN.join(','))
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const unknown = browsers.find((name) => !KNOWN.includes(name));
  if (unknown !== undefined || browsers.length === 0) {
    throw new Error(
      `SWF_BROWSERS must list some of ${KNOWN.join(', ')} (got "${String(env.SWF_BROWSERS)}")`,
    );
  }
  const channels = {
    chromium: env.SWF_CHROMIUM_CHANNEL ?? '',
    firefox: env.SWF_FIREFOX_CHANNEL ?? '',
    webkit: '',
  };
  return browsers.map((browser) =>
    channels[browser] === ''
      ? { browser }
      : { browser, provider: playwright({ launchOptions: { channel: channels[browser] } }) },
  );
}

/** Where the test frame stands on the page, so points of the frame map to the page. */
async function frameBox(ctx) {
  const frame = await ctx.frame();
  const element = await frame.frameElement();
  const box = await element.boundingBox();
  if (box === null) {
    throw new Error('the test frame has no box');
  }
  return box;
}

/**
 * Moves, presses and releases the real mouse at a point of the test frame, so the browser
 * produces genuine (trusted) pointer events.
 */
export async function mouse(ctx, action, x, y, modifiers = []) {
  const box = await frameBox(ctx);
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

/**
 * Emulates what the reader asked their browser for: reduced motion, a dark or light appearance.
 * Each is kept until it is emulated again; `null` puts the platform's own back.
 */
export async function emulate(ctx, media) {
  await ctx.page.emulateMedia(media);
}

/**
 * Turns the real mouse wheel by (deltaX, deltaY) pixels over a point of the test frame, with
 * modifier keys held, so the browser produces a genuine wheel event.
 */
export async function wheel(ctx, x, y, deltaX, deltaY, modifiers = []) {
  const box = await frameBox(ctx);
  await ctx.page.mouse.move(box.x + x, box.y + y);
  for (const key of modifiers) {
    await ctx.page.keyboard.down(key);
  }
  await ctx.page.mouse.wheel(deltaX, deltaY);
  for (const key of modifiers) {
    await ctx.page.keyboard.up(key);
  }
}

/**
 * The page's DevTools session, for input only Chromium can make (touch and pen): one for each
 * page, kept, since Chromium follows a touch from its start through the session that began it.
 */
const sessions = new WeakMap();
async function devtools(ctx, what) {
  if (ctx.context.browser()?.browserType().name() !== 'chromium') {
    throw new Error(`${what} input can be made only in Chromium, over the DevTools protocol`);
  }
  let session = sessions.get(ctx.page);
  if (session === undefined) {
    session = await ctx.context.newCDPSession(ctx.page);
    sessions.set(ctx.page, session);
  }
  return session;
}

/**
 * Touches the screen as a finger does, at points of the test frame: `start`, `move` or `end`,
 * with every finger then on the screen (ids keep fingers apart). Chromium only.
 */
export async function touch(ctx, phase, points) {
  const types = { start: 'touchStart', move: 'touchMove', end: 'touchEnd' };
  if (!(phase in types)) {
    throw new Error(`touch: phase must be start, move or end (got ${String(phase)})`);
  }
  const box = await frameBox(ctx);
  const session = await devtools(ctx, 'touch');
  await session.send('Input.dispatchTouchEvent', {
    type: types[phase],
    touchPoints: points.map((p) => ({ x: box.x + p.x, y: box.y + p.y, id: p.id, force: 1 })),
  });
}

/**
 * Moves, presses or releases a pen at a point of the test frame, with a pressure: a move with
 * pressure is a move with the pen down. Chromium only.
 */
export async function pen(ctx, action, x, y, pressure = 0.5) {
  const types = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' };
  if (!(action in types)) {
    throw new Error(`pen: action must be move, down or up (got ${String(action)})`);
  }
  const box = await frameBox(ctx);
  const session = await devtools(ctx, 'pen');
  await session.send('Input.dispatchMouseEvent', {
    type: types[action],
    x: box.x + x,
    y: box.y + y,
    button: action === 'move' ? 'none' : 'left',
    buttons: action === 'down' || (action === 'move' && pressure > 0) ? 1 : 0,
    clickCount: action === 'move' ? 0 : 1,
    pointerType: 'pen',
    force: action === 'up' ? 0 : pressure,
  });
}

/**
 * Presses the real mouse at a point of the test frame and moves it every `stepMs` along a sine of
 * `amplitude` pixels and `periodMs` across (or down, with `axis: 'y'`), for whole periods lasting
 * `durationMs` at least, then releases it where it pressed: a drag as long and as steady as a
 * person's, at a mouse's report rate, that leaves what it dragged back where it began. Returns how
 * many moves it made and how long it swept, in milliseconds.
 */
export async function sweep(ctx, options) {
  const { x, y, amplitude, periodMs, durationMs, stepMs = 8, axis = 'x' } = options;
  for (const [name, value] of Object.entries({ x, y, amplitude, periodMs, durationMs, stepMs })) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`sweep: ${name} must be a finite number (got ${String(value)})`);
    }
  }
  if (axis !== 'x' && axis !== 'y') {
    throw new Error(`sweep: axis must be x or y (got ${String(axis)})`);
  }
  const box = await frameBox(ctx);
  const mouse = ctx.page.mouse;
  await mouse.move(box.x + x, box.y + y);
  await mouse.down();
  const total = Math.max(1, Math.ceil(durationMs / periodMs)) * periodMs;
  const start = performance.now();
  let next = start;
  let moves = 0;
  for (let now = start; now - start < total; now = performance.now()) {
    const offset = amplitude * Math.sin((2 * Math.PI * (now - start)) / periodMs);
    const at = axis === 'x' ? [x + offset, y] : [x, y + offset];
    await mouse.move(box.x + at[0], box.y + at[1]);
    moves += 1;
    next += stepMs;
    const wait = next - performance.now();
    if (wait > 0) {
      await sleep(wait);
    } else {
      next = performance.now();
    }
  }
  await mouse.move(box.x + x, box.y + y);
  await mouse.up();
  return { moves: moves + 1, durationMs: total };
}

/**
 * The browser's JavaScript heap after collecting garbage twice, in bytes: V8's own heap and the
 * embedder's (the DOM's) as Chromium reports them over the DevTools protocol. Other engines
 * report no heap to automation: null for them.
 */
export async function heap(ctx) {
  if (ctx.context.browser()?.browserType().name() !== 'chromium') {
    return null;
  }
  const session = await ctx.context.newCDPSession(ctx.page);
  try {
    await session.send('HeapProfiler.collectGarbage');
    await session.send('HeapProfiler.collectGarbage');
    const usage = await session.send('Runtime.getHeapUsage');
    return {
      used: usage.usedSize,
      embedder: typeof usage.embedderHeapUsedSize === 'number' ? usage.embedderHeapUsedSize : null,
    };
  } finally {
    await session.detach();
  }
}

const require = createRequire(import.meta.url);

/** The browser, its build and the machine a run measured on (AN-010). */
export async function environment(ctx) {
  const browser = ctx.context.browser();
  const cpus = os.cpus();
  return {
    browser: {
      engine: browser?.browserType().name() ?? null,
      version: browser?.version() ?? null,
      userAgent: await ctx.page.evaluate(() => globalThis.navigator.userAgent),
    },
    machine: {
      os: `${os.type()} ${os.release()}`,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus[0]?.model ?? null,
      cores: cpus.length,
      memoryBytes: os.totalmem(),
    },
    tools: {
      node: process.version,
      playwright: require('playwright/package.json').version,
      vitest: require('vitest/package.json').version,
    },
  };
}

/**
 * Writes a run's record (JSON text) to the folder SWF_RECORD_DIR names, under a plain file name:
 * how a benchmark or conformance run hands what it measured to the machine running it.
 */
export async function record(_ctx, name, text) {
  const folder = process.env.SWF_RECORD_DIR;
  if (folder === undefined || folder === '' || !path.isAbsolute(folder)) {
    throw new Error(
      `SWF_RECORD_DIR must name an absolute folder to record in (got "${String(folder)}")`,
    );
  }
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.json$/.test(name)) {
    throw new Error(`a record's name must be a plain .json file name (got "${String(name)}")`);
  }
  JSON.parse(text);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, name), text);
}
