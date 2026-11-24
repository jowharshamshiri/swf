import { cameraRotation } from '@swf/projections';
import { afterEach, describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import type { BenchmarkHost, Fixture, Growth } from '../../src/index.js';
import {
  createBenchmarkHost,
  createResourceProbe,
  growthExponent,
  layoutViewports,
  planFixture,
  recordControl,
  STANDARD,
  summarize,
} from '../../src/index.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
    heap: () => Promise<{ used: number; embedder: number | null } | null>;
  }
}

let host: BenchmarkHost | null = null;
let parent: HTMLElement | null = null;
afterEach(async () => {
  await host?.dispose();
  parent?.remove();
  host = null;
  parent = null;
});

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** An element at the page's top left, for a host's viewports. */
function page(): HTMLElement {
  const element = document.createElement('div');
  element.style.setProperty('position', 'absolute');
  element.style.setProperty('left', '0');
  element.style.setProperty('top', '0');
  document.body.append(element);
  parent = element;
  return element;
}

async function present(
  fixture: Fixture,
  containers: readonly HTMLElement[] = layoutViewports(page(), fixture),
): Promise<BenchmarkHost> {
  const made = await createBenchmarkHost({ fixture, containers });
  await made.settled();
  return made;
}

/** One window's move, as a drag would make it: a preview, then its commit. */
function move(h: BenchmarkHost, id: string, turn: number): void {
  const node = h.workspace.getState().nodes.get(id);
  if (node === undefined) {
    throw new Error(`no ${id}`);
  }
  const [x, y, z] = node.transform.position;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const transform = { ...node.transform, position: [c * x - s * z, y, s * x + c * z] as const };
  const commands = [{ type: 'node.patch' as const, id, transform }];
  h.workspace.preview('bench', commands, { source: 'user' });
  const done = h.workspace.transaction(commands, { source: 'user', previewId: 'bench' });
  if (done.status !== 'committed') {
    throw new Error(`the move of ${id} was not committed: ${JSON.stringify(done)}`);
  }
}

describe('the standard benchmark fixture in a real browser (§26.1)', () => {
  it('presents 30 to 50 surfaces in each of its two viewports, plain elements live', async () => {
    host = await present(planFixture(STANDARD, 1));
    expect(host.viewports).toHaveLength(2);
    for (const v of host.viewports) {
      const frame = v.viewport.lastFrame();
      const surfaces = new Set(frame?.frame.planned.map((p) => p.fragment.surfaceId));
      expect(surfaces.size).toBeGreaterThanOrEqual(30);
      expect(surfaces.size).toBeLessThanOrEqual(50);
      expect(frame?.frame.planned.some((p) => p.negotiation.mode === 'approximated')).toBe(true);
      expect(frame?.frame.planned.some((p) => p.negotiation.mode === 'proxy')).toBe(true);
      expect(v.container.querySelectorAll('[data-swf-surface]').length).toBeGreaterThan(0);
    }
  });
});

describe('the control a run is read against', () => {
  it('moves one plain element every animation frame for as long as asked, then takes it away', async () => {
    const element = page();
    const stamps = await recordControl(element, { width: 1920, height: 1080 }, 500);
    // Half a second at any ordinary frame rate: more than a dozen frames, in order.
    expect(stamps.length).toBeGreaterThan(12);
    expect(stamps.every((t, i) => i === 0 || t >= (stamps[i - 1] ?? 0))).toBe(true);
    expect(element.childElementCount).toBe(0);
  });
});

describe('a disposal soak (NFR-010, QA-010)', () => {
  it('returns listeners, observers, frames and timers to baseline over 100 dispose-and-recreate cycles, retaining no heap growth', async () => {
    const fixture = planFixture(STANDARD, 1);
    // The host's elements stay in the page throughout, as an application's own page does.
    const element = page();
    const containers = layoutViewports(element, fixture);
    const probe = createResourceProbe(window);
    try {
      await nextFrame();
      const baseline = probe.counts();
      const before = await commands.heap();
      /** The heap after each tenth cycle, where the browser reports it. */
      const heaps: Growth[] = [];
      let hostBytes: number | null = null;
      for (let cycle = 1; cycle <= 100; cycle++) {
        host = await present(fixture, containers);
        expect(probe.counts().listeners).toBeGreaterThan(baseline.listeners);
        // Work the scene a little, so that what disposal undoes was all in use.
        const camera = fixture.viewports[0]?.cameraId ?? '';
        host.workspace.dispatch({
          type: 'camera.patch',
          id: camera,
          rotation: cameraRotation(0.1, 0),
        });
        move(host, 'window-001', 0.05);
        await nextFrame();
        if (cycle === 1 && before !== null) {
          const alive = await commands.heap();
          hostBytes = (alive?.used ?? 0) - before.used;
        }
        await host.dispose();
        host = null;
        await nextFrame();
        await nextFrame();
        expect(probe.counts(), `after cycle ${String(cycle)}`).toEqual(baseline);
        expect(containers.every((c) => c.isConnected && c.childElementCount === 0)).toBe(true);
        if (cycle % 10 === 0) {
          const after = await commands.heap();
          if (after !== null) {
            heaps.push({ n: cycle, cost: after.used });
          }
        }
      }
      if (before !== null) {
        // Chromium reports its heap: over the last ninety cycles it grew by less than one host's
        // worth all told, so nothing a cycle made is kept.
        expect(hostBytes).toBeGreaterThan(0);
        const first = heaps[0]?.cost ?? 0;
        const last = heaps.at(-1)?.cost ?? 0;
        expect(last - first).toBeLessThan(hostBytes ?? 0);
      }
    } finally {
      probe.dispose();
      element.remove();
    }
  }, 600_000);
});

describe('one window’s move as the scene grows (§33.2 scenario 9, NFR-002, NFR-008)', () => {
  it('renders the benchmark fixture and moves one window at a cost that grows less than quadratically with the scene', async () => {
    const sizes = [125, 250, 500, 1000];
    const transaction: Growth[] = [];
    const frame: Growth[] = [];
    const moves = 40;
    for (const windows of sizes) {
      const fixture = planFixture({ windows, surfaces: windows * 1.2, groups: 5 }, 1);
      host = await present(fixture);
      const h = host;
      const main = h.viewports[0];
      if (main === undefined) {
        throw new Error('no viewport');
      }
      // A window in view ahead, moved back and forth.
      const ahead =
        fixture.windows.find((w) => Math.abs(w.heading) < 10 && w.elevation === 0) ??
        fixture.windows.find((w) => Math.abs(w.heading) < 20);
      if (ahead === undefined) {
        throw new Error('no window ahead');
      }
      const txTimes: number[] = [];
      const frameTimes: number[] = [];
      for (let i = 0; i < moves; i++) {
        const t0 = performance.now();
        move(h, ahead.id, i % 2 === 0 ? 0.02 : -0.02);
        const t1 = performance.now();
        const presented = await main.viewport.update();
        const t2 = performance.now();
        expect(presented.status).toBe('presented');
        txTimes.push(t1 - t0);
        frameTimes.push(t2 - t1);
      }
      // Coarse clocks report whole milliseconds: a mean over the moves resolves them.
      transaction.push({ n: windows, cost: Math.max(1e-3, summarize(txTimes).mean) });
      frame.push({ n: windows, cost: Math.max(1e-3, summarize(frameTimes).mean) });
      await host.dispose();
      host = null;
      parent?.remove();
      parent = null;
    }
    const exponents = { transaction: growthExponent(transaction), frame: growthExponent(frame) };
    console.info(JSON.stringify({ transaction, frame, exponents }));
    expect(exponents.transaction).toBeLessThan(1.5);
    expect(exponents.frame).toBeLessThan(1.5);
  }, 300_000);
});
