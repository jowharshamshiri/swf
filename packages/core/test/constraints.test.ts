import { mat4TransformPoint, quatRotate } from '@swf/math';
import { describe, expect, it } from 'vitest';
import type { Constraint } from '../src/index.js';
import {
  axisLockConstraint,
  collisionSpacingConstraint,
  distanceConstraint,
  facePointConstraint,
  gridSnapConstraint,
  SwfFailure,
  worldBoundsConstraint,
  worldMatrix,
} from '../src/index.js';
import { at, committed, expectClose, makeWorkspace, rejected, window } from './helpers.js';

const worldOrigin = (ws: ReturnType<typeof makeWorkspace>, id: string) => {
  const m = worldMatrix(ws.getState().nodes, id);
  return m === undefined ? [] : mat4TransformPoint(m, [0, 0, 0]);
};

describe('built-in constraints', () => {
  it('clamps the world origin into a box, through a moved parent', () => {
    const ws = makeWorkspace({
      constraints: [worldBoundsConstraint({ id: 'room', min: [-5, 0, -5], max: [5, 3, 5] })],
    });
    committed(
      ws.transaction([
        window('p', { transform: at([4, 0, 0]) }),
        window('c', { parentId: 'p', transform: at([3, 5, 0]) }),
      ]),
    );
    expectClose(worldOrigin(ws, 'c'), [5, 3, 0]);
    expectClose(ws.getState().nodes.get('c')?.transform.position ?? [], [1, 3, 0]);
  });

  it('locks movement along chosen world axes for existing nodes', () => {
    const ws = makeWorkspace({ constraints: [axisLockConstraint({ id: 'floor', axes: ['y'] })] });
    committed(ws.dispatch(window('a', { transform: at([0, 1.5, -3]) })));
    committed(ws.dispatch({ type: 'node.patch', id: 'a', transform: at([2, 9, -4]) }));
    expectClose(worldOrigin(ws, 'a'), [2, 1.5, -4]);
  });

  it('keeps nodes on a spherical shell around the viewer', () => {
    const ws = makeWorkspace({
      constraints: [distanceConstraint({ id: 'shell', center: [0, 0, 0], min: 2, max: 4 })],
    });
    committed(
      ws.transaction([
        window('near', { transform: at([0, 0, -1]) }),
        window('far', { transform: at([0, 6, -8]) }),
      ]),
    );
    expectClose(worldOrigin(ws, 'near'), [0, 0, -2]);
    expectClose(worldOrigin(ws, 'far'), [0, 2.4, -3.2]);
    const centred = rejected(ws.dispatch(window('centre')));
    expect(centred.error.code).toBe('CONSTRAINT_REJECTED');
  });

  it('snaps the world origin to a grid', () => {
    const ws = makeWorkspace({ constraints: [gridSnapConstraint({ id: 'grid', step: 0.5 })] });
    committed(ws.dispatch(window('a', { transform: at([0.74, -0.26, -2.1]) })));
    expectClose(worldOrigin(ws, 'a'), [0.5, -0.5, -2]);
  });

  it('turns nodes to face the viewer, upright', () => {
    const ws = makeWorkspace({
      constraints: [facePointConstraint({ id: 'face', point: [0, 0, 0] })],
    });
    committed(ws.dispatch(window('a', { transform: at([3, 0, 0]) })));
    const rotation = ws.getState().nodes.get('a')?.transform.rotation ?? [0, 0, 0, 1];
    expectClose(quatRotate(rotation, [0, 0, 1]), [-1, 0, 0]);
    expectClose(quatRotate(rotation, [0, 1, 0]), [0, 1, 0]);
    expect(rejected(ws.dispatch(window('above', { transform: at([0, 5, 0]) }))).error.code).toBe(
      'CONSTRAINT_REJECTED',
    );
  });

  it('rejects placements closer than the spacing to another node', () => {
    const ws = makeWorkspace({
      constraints: [collisionSpacingConstraint({ id: 'gap', padding: 0.2 })],
    });
    committed(ws.dispatch(window('a', { transform: at([0, 0, -3]), bounds: [1, 1, 0.1] })));
    committed(ws.dispatch(window('b', { transform: at([1.3, 0, -3]), bounds: [1, 1, 0.1] })));
    const result = rejected(
      ws.dispatch({ type: 'node.patch', id: 'b', transform: at([1.1, 0, -3]) }),
    );
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_REJECTED',
      entityId: 'b',
      details: { constraintId: 'gap' },
    });
    expect(ws.getState().nodes.get('b')?.transform.position).toEqual([1.3, 0, -3]);
  });
});

describe('constraint resolution', () => {
  it('lets required constraints win over optional preferences', () => {
    const ws = makeWorkspace({
      constraints: [
        gridSnapConstraint({ id: 'snap', step: 1, required: false, order: 0 }),
        worldBoundsConstraint({
          id: 'bounds',
          min: [-0.5, -10, -10],
          max: [0.5, 10, 10],
          order: 1,
        }),
      ],
    });
    // Snapping 0.4 to 0 is allowed; snapping 0.7 to 1 would break the required bounds.
    committed(ws.dispatch(window('a', { transform: at([0.4, 0, -3]) })));
    expectClose(worldOrigin(ws, 'a'), [0, 0, -3]);
    committed(ws.dispatch({ type: 'node.patch', id: 'a', transform: at([0.7, 0, -3]) }));
    expectClose(worldOrigin(ws, 'a'), [0.5, 0, -3]);
  });

  it('rejects when the required constraints cannot all hold, preserving the scene', () => {
    const ws = makeWorkspace({
      constraints: [
        worldBoundsConstraint({ id: 'left', min: [-10, -10, -10], max: [-1, 10, 10], order: 0 }),
        worldBoundsConstraint({ id: 'right', min: [1, -10, -10], max: [10, 10, 10], order: 1 }),
      ],
    });
    const before = ws.getState();
    const result = rejected(ws.dispatch(window('a', { transform: at([0, 0, -3]) })));
    expect(result.error.code).toBe('CONSTRAINT_REJECTED');
    expect(result.error.message).toMatch(/cannot all be satisfied/);
    expect(ws.getState()).toBe(before);
  });

  it('resolves in configured order, ties broken by ID, whatever the registration order', () => {
    const calls: string[] = [];
    const spy = (id: string, order: number): Constraint => ({
      id,
      order,
      required: false,
      resolve: (input) => {
        calls.push(id);
        return { kind: 'accept', transform: input.transform };
      },
    });
    const ws = makeWorkspace({ constraints: [spy('z', 1), spy('b', 0), spy('a', 0)] });
    committed(ws.dispatch(window('n')));
    expect(calls.slice(0, 3)).toEqual(['a', 'b', 'z']);
  });

  it('applies a constraint only to the nodes it governs', () => {
    const ws = makeWorkspace({
      constraints: [
        gridSnapConstraint({
          id: 'snap',
          step: 1,
          appliesTo: (node) => node.tags.includes('snap'),
        }),
      ],
    });
    committed(
      ws.transaction([
        window('free', { transform: at([0.3, 0, 0]) }),
        window('held', { transform: at([0.3, 0, 0]), tags: ['snap'] }),
      ]),
    );
    expectClose(worldOrigin(ws, 'free'), [0.3, 0, 0]);
    expectClose(worldOrigin(ws, 'held'), [0, 0, 0]);
  });

  it('treats a constraint that throws or returns an invalid transform as a rejection', () => {
    const throwing: Constraint = {
      id: 'broken',
      order: 0,
      required: false,
      resolve: () => {
        throw new Error('boom');
      },
    };
    const ws = makeWorkspace({ constraints: [throwing] });
    expect(rejected(ws.dispatch(window('a'))).error.message).toMatch(
      /"broken".*its resolve threw: boom/,
    );
    const invalid: Constraint = {
      id: 'nan',
      order: 0,
      required: true,
      resolve: (input) => ({
        kind: 'accept',
        transform: { ...input.transform, position: [NaN, 0, 0] },
      }),
    };
    const other = makeWorkspace({ constraints: [invalid] });
    expect(rejected(other.dispatch(window('a'))).error.message).toMatch(
      /invalid transform: position/,
    );
  });

  it('checks constraints on registration and removes them with the returned function', () => {
    const ws = makeWorkspace();
    const remove = ws.registerConstraint(gridSnapConstraint({ id: 'snap', step: 1 }));
    expect(() => ws.registerConstraint(gridSnapConstraint({ id: 'snap', step: 2 }))).toThrow(
      SwfFailure,
    );
    expect(() => ws.registerConstraint({ id: 'x', order: 0, required: 'yes' } as never)).toThrow(
      /required must be a boolean/,
    );
    committed(ws.dispatch(window('a', { transform: at([0.3, 0, 0]) })));
    expectClose(worldOrigin(ws, 'a'), [0, 0, 0]);
    remove();
    remove();
    committed(ws.dispatch(window('b', { transform: at([0.3, 0, 0]) })));
    expectClose(worldOrigin(ws, 'b'), [0.3, 0, 0]);
  });

  it('does not re-apply constraints on undo, which restores the recorded placement', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a', { transform: at([0.3, 0, 0]) })));
    committed(ws.dispatch({ type: 'node.patch', id: 'a', transform: at([0.6, 0, 0]) }));
    ws.registerConstraint(gridSnapConstraint({ id: 'snap', step: 1 }));
    committed(ws.undo());
    expectClose(worldOrigin(ws, 'a'), [0.3, 0, 0]);
  });
});
