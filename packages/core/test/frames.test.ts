import { normalize } from '@swf/math';
import { describe, expect, it } from 'vitest';
import { nodeFrameGeometry } from '../src/index.js';
import { at, committed, expectClose, makeWorkspace, window } from './helpers.js';

describe('node frames', () => {
  it('place a node’s bounds rectangle in the world, through its ancestors', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('group', { bounds: [1, 1, 1], transform: at([0, 1, -4], Math.PI / 2) }),
        window('w', { parentId: 'group', bounds: [2, 1, 0.01], transform: at([0, 0, 1]) }),
      ]),
    );
    const frame = nodeFrameGeometry(ws.getState(), 'w');
    expect(frame).toMatchObject({
      surfaceId: 'w',
      kind: 'rect',
      supported: true,
      fidelity: 'exact',
    });
    // The group turns its child a quarter about +Y: the child sits at (1, 1, -4), facing +X.
    expectClose(frame?.normal ?? [], [1, 0, 0], 1e-12);
    const hit = frame?.intersect({ origin: [5, 1.2, -3.5], direction: normalize([-1, 0, 0]) });
    expect(hit?.distance).toBeCloseTo(4, 12);
    expectClose(hit?.point ?? [], [1, 1.2, -3.5], 1e-12);
    // The turn sends the child's own +x to world -Z, so +0.5 in z is -0.5 along its x.
    expectClose(hit?.localPoint ?? [], [-0.5, 0.2, 0], 1e-12);
    // Outside the 2 × 1 rectangle there is no hit.
    expect(frame?.intersect({ origin: [5, 1.8, -4], direction: [-1, 0, 0] })).toBeNull();
    expect(nodeFrameGeometry(ws.getState(), 'none')).toBeUndefined();
  });
});
