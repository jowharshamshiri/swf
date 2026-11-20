import type { SceneCommand } from '@swf/core';
import { cameraRotation } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import { H, W, world } from './fixtures.js';

declare const performance: { now(): number };

/**
 * The standard benchmark fixture: 250 windows and 300 surfaces (every fifth window carries a
 * second surface), five nested groups holding half the windows, and two viewports.
 */
function standardFixture() {
  const groups: SceneCommand[] = [];
  for (let i = 1; i <= 5; i++) {
    groups.push({
      type: 'node.create',
      node: {
        id: `g${String(i)}`,
        kind: 'group',
        bounds: [1, 1, 1],
        ...(i === 1 ? {} : { parentId: `g${String(i - 1)}` }),
      },
    });
  }
  const windows: SceneCommand[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 250; i++) {
    const heading = i * golden;
    const distance = 2.5 + (i % 11) * 0.5;
    const id = `w${String(i)}`;
    windows.push({
      type: 'node.create',
      node: {
        id,
        kind: 'window',
        bounds: [1.6, 0.9, 0.01],
        ...(i % 2 === 0 ? { parentId: `g${String((i % 5) + 1)}` } : {}),
        transform: {
          position: [
            distance * Math.sin(heading),
            ((i % 7) - 3) * 0.6,
            -distance * Math.cos(heading),
          ],
          rotation: cameraRotation(heading, 0),
          scale: [1, 1, 1],
        },
      },
    });
    for (let s = 0; s < (i % 5 === 0 ? 2 : 1); s++) {
      windows.push({
        type: 'surface.attach',
        surface: {
          id: `${id}-s${String(s)}`,
          ownerNodeId: id,
          bindingKey: `key-${id}-${String(s)}`,
          adapterTypeId: 'host.view/1',
          bounds: [0.7, 0.6, 0.01],
          transform: {
            position: [s === 0 ? -0.38 : 0.38, -0.05, 0.001],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      });
    }
  }
  return world([], {
    extra: [
      ...groups,
      ...windows,
      { type: 'camera.create', camera: { id: 'cam2', rotation: cameraRotation(1.5, 0.1) } },
      {
        type: 'viewport.create',
        viewport: {
          id: 'v2',
          cameraId: 'cam2',
          projection: { id: 'equirectangular/1', config: { horizontal: 180, vertical: 90 } },
          size: { width: 960, height: 540, devicePixelRatio: 1 },
        },
      },
    ],
  });
}

describe('picking performance (NFR-003)', () => {
  it('answers a single-pointer pick on the standard fixture in under 2 ms at p95', () => {
    const { ws, router } = standardFixture();
    const state = ws.getState();
    expect([...state.nodes.values()].filter((n) => n.kind === 'window')).toHaveLength(250);
    expect(state.surfaces.size).toBe(300);
    expect(state.viewports.size).toBe(2);
    // A deterministic spread of points over both viewports.
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const points = Array.from({ length: 2400 }, (_, i) =>
      i % 2 === 0
        ? { viewportId: 'v', x: random() * W, y: random() * H }
        : { viewportId: 'v2', x: random() * 960, y: random() * 540 },
    );
    // Warm up (the first pick also builds the index).
    for (const p of points.slice(0, 400)) {
      router.pick(p.viewportId, p.x, p.y);
    }
    const timings: number[] = [];
    let hits = 0;
    for (const p of points.slice(400)) {
      const start = performance.now();
      const result = router.pick(p.viewportId, p.x, p.y);
      timings.push(performance.now() - start);
      if (result.kind === 'hit') {
        hits += 1;
      }
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95)] ?? Infinity;
    // The points land on windows often enough for the measure to mean something.
    expect(hits).toBeGreaterThan(200);
    expect(p95).toBeLessThan(2);
  });
});
