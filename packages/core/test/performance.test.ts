import { describe, expect, it } from 'vitest';
import type { SceneCommand, Workspace } from '../src/index.js';
import { at, committed, makeWorkspace } from './helpers.js';

declare const performance: { now(): number };

/** The standard fixture's scene shape: `count` windows, half of them inside five nested groups. */
function fixture(count: number): Workspace {
  const ws = makeWorkspace();
  const commands: SceneCommand[] = [];
  for (let g = 0; g < 5; g++) {
    commands.push({
      type: 'node.create',
      node: {
        id: `group-${String(g)}`,
        kind: 'group',
        parentId: g === 0 ? null : `group-${String(g - 1)}`,
        bounds: [1, 1, 1],
      },
    });
  }
  for (let i = 0; i < count; i++) {
    const yaw = (i / count) * 2 * Math.PI;
    commands.push({
      type: 'node.create',
      node: {
        id: `w${String(i)}`,
        kind: 'window',
        parentId: i % 2 === 0 ? null : `group-${String(i % 5)}`,
        bounds: [1.6, 0.9, 0.01],
        transform: at([4 * Math.sin(yaw), (i % 7) - 3, -4 * Math.cos(yaw)], yaw),
      },
    });
  }
  committed(ws.transaction(commands));
  return ws;
}

function p95MoveMillis(ws: Workspace, runs: number): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    committed(
      ws.dispatch(
        { type: 'node.patch', id: 'w7', transform: at([(i % 30) / 10, 0, -4]) },
        { source: 'user' },
      ),
    );
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length * 0.95)] ?? Infinity;
}

describe('transaction cost', () => {
  it('moves one window among 250 within the 5 ms p95 budget, and stays bounded at 500', () => {
    const standard = fixture(250);
    const stress = fixture(500);
    p95MoveMillis(standard, 200);
    p95MoveMillis(stress, 200);
    const p95Standard = p95MoveMillis(standard, 1000);
    const p95Stress = p95MoveMillis(stress, 1000);
    expect(p95Standard).toBeLessThan(5);
    expect(p95Stress).toBeLessThan(5);
  });
});
