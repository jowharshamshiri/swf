import { worldMatrix } from '@swf/core';
import { quatFromAxisAngle } from '@swf/math';
import type { RenderFrame, Representation } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import { CAMERA_ID } from '@swf/navigation';
import { PART_OF_KEY } from '../src/presets.js';
import { spaceStatus } from '@swf/navigation';
import { policyWorld, VIEWPORT } from './policy-world.js';

/** A frame of the studio showing these windows' surfaces, each fragment as it is represented. */
function frameOf(
  world: ReturnType<typeof policyWorld>,
  shown: readonly (readonly [string, Representation])[],
): RenderFrame {
  const scene = world.ws.getState();
  return {
    viewportId: VIEWPORT,
    scene,
    planned: shown.map(([id, representation]) => ({
      fragment: { surfaceId: scene.nodes.get(id)?.surfaceIds[0] ?? '', bounds: [0, 0, 1, 1] },
      representation,
    })),
  } as unknown as RenderFrame;
}

describe('the status of the space, in the reader’s terms', () => {
  /** The studio's windows, each with its heading round the camera, from the scene itself. */
  const windowsOf = (world: ReturnType<typeof policyWorld>) => {
    const state = world.ws.getState();
    return [...state.nodes.values()]
      .filter((n) => n.kind === 'window')
      .map((n) => {
        const m = worldMatrix(state.nodes, n.id);
        if (m === undefined) {
          throw new Error(`no place for ${n.id}`);
        }
        return { id: n.id, heading: (Math.atan2(m[12], -m[14]) * 180) / Math.PI };
      });
  };
  /** How many of them lie behind a camera facing `heading` degrees. */
  const behindOf = (world: ReturnType<typeof policyWorld>, heading: number) =>
    windowsOf(world).filter((w) => Math.cos(((w.heading - heading) * Math.PI) / 180) < 0).length;

  it('counts the windows, those shown, those behind, and how each shown is shown, its fullest way', () => {
    const world = policyWorld('studio');
    const [a, b, c] = windowsOf(world).map((w) => w.id);
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('the studio has fewer than three windows');
    }
    const status = spaceStatus(
      frameOf(world, [
        // One window in two pieces (across the seam, say), once in full: shown whole.
        [a, 'label'],
        [a, 'full'],
        [b, 'compact'],
        [c, 'label'],
      ]),
      PART_OF_KEY,
    );
    expect(status.windows).toBe(13);
    expect(status.inView).toBe(3);
    expect(status.shown).toEqual({ full: 1, compact: 1, label: 1 });
    expect(status.behind).toBe(behindOf(world, 0));
    expect(status.facing).toBe(0);
  });

  it('follows the camera: where it faces, and what lies behind it then', () => {
    const world = policyWorld('studio');
    for (const heading of [62, -120, 180]) {
      const result = world.ws.transaction([
        {
          type: 'camera.patch',
          id: CAMERA_ID,
          rotation: quatFromAxisAngle([0, 1, 0], (-heading * Math.PI) / 180),
        },
      ]);
      expect(result.status).toBe('committed');
      const status = spaceStatus(frameOf(world, []), PART_OF_KEY);
      expect(status.facing).toBe(heading);
      expect(status.behind).toBe(behindOf(world, heading));
      expect(status.inView).toBe(0);
    }
  });
});
