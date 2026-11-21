import {
  MOCK_COMPOSITOR_CAPABILITIES,
  MOCK_RENDERER_CAPABILITIES,
  MockOpaqueAdapter,
} from '@swf/conformance';
import type { SceneCommand, ViewportSpec, Workspace } from '@swf/core';
import { createWorkspace, SwfFailure } from '@swf/core';
import { quatFromAxisAngle, quatRotate, quatSameRotation } from '@swf/math';
import type { ViewGeometry } from '@swf/presentation';
import {
  createPresentationRegistry,
  createViewOutput,
  planFrame,
  viewGeometryOf,
} from '@swf/presentation';
import { createSurfaceRuntime } from '@swf/surfaces';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cameraRotation,
  createProjectionRegistry,
  equirectangular,
  headingPitchOf,
  pickAt,
  projectionFor,
} from '../src/index.js';
import { placedCommands } from './fixtures.js';

const viewport = (
  id: string,
  cameraId: string,
  extra: Partial<ViewportSpec> = {},
): SceneCommand => ({
  type: 'viewport.create',
  viewport: {
    id,
    cameraId,
    projection: { id: 'equirectangular/1', config: { horizontal: 360, vertical: 120 } },
    size: { width: 800, height: 400, devicePixelRatio: 2 },
    ...extra,
  },
});

/** A workspace with the equirectangular projection registered, three surfaces and two viewports. */
function world() {
  const ws = createWorkspace({ id: 'ws' });
  const presentation = createPresentationRegistry();
  createProjectionRegistry({ kinds: ws.mutator(), projectors: presentation.registrar() }).register(
    equirectangular,
  );
  const result = ws.transaction([
    ...placedCommands([
      { id: 'ahead', heading: 0, distance: 2 },
      { id: 'right', heading: Math.PI / 2, distance: 3 },
      { id: 'behind', heading: Math.PI - 0.05, distance: 2 },
    ]),
    { type: 'camera.create', camera: { id: 'main' } },
    { type: 'camera.create', camera: { id: 'side', rotation: cameraRotation(Math.PI / 2, 0) } },
    viewport('wide', 'main'),
    viewport('narrow', 'side', {
      projection: { id: 'equirectangular/1', config: { horizontal: 90, vertical: 60 } },
      size: { width: 300, height: 200, devicePixelRatio: 1 },
    }),
  ]);
  if (result.status !== 'committed') {
    throw new Error(JSON.stringify(result));
  }
  const projector = presentation.projector('equirectangular/1')?.module;
  if (projector === undefined) {
    throw new Error('projector not registered');
  }
  const project = (viewportId: string) => {
    const state = ws.getState();
    return createViewOutput(
      state,
      viewportId,
      projector.project(state, viewGeometryOf(state, viewportId), (id) => ws.surfaceGeometry(id)),
    );
  };
  return { ws, project };
}

const layout = (ws: Workspace) => {
  const state = ws.getState();
  return { nodes: [...state.nodes.values()], surfaces: [...state.surfaces.values()] };
};

describe('several viewports over one scene (FR-060, FR-069, FR-072, AC-002)', () => {
  it('give each viewport its own camera, projection and size', () => {
    const { project } = world();
    const wide = project('wide');
    const narrow = project('narrow');
    // The wide view shows all three, the one behind split across its seam.
    expect(wide.fragmentsOf('ahead')).toHaveLength(1);
    expect(wide.fragmentsOf('right')).toHaveLength(1);
    expect(wide.fragmentsOf('behind')).toHaveLength(2);
    // The narrow view looks right with 90°: only the surface on the right, centred.
    expect(narrow.fragments.map((f) => f.surfaceId)).toEqual(['right']);
    const [f] = narrow.fragments;
    expect((f?.bounds[0] ?? 0) + (f?.bounds[2] ?? 0) / 2).toBeCloseTo(150, 9);
    expect(f?.viewportId).toBe('narrow');
  });

  it('never change the layout or the bindings when cameras, projections or sizes change', async () => {
    const { ws, project } = world();
    const runtime = createSurfaceRuntime(ws, { autoBind: false });
    runtime.registerAdapter(new MockOpaqueAdapter());
    for (const id of ['ahead', 'right', 'behind']) {
      expect(await runtime.bind(id)).toMatchObject({
        status: 'ok',
        presentation: { state: 'ready' },
      });
    }
    const before = layout(ws);
    const bindings = runtime.list();
    const fragmentsBefore = project('wide').fragments;
    const changes: SceneCommand[] = [
      { type: 'camera.patch', id: 'main', rotation: cameraRotation(1, 0.2), position: [0.5, 0, 0] },
      {
        type: 'viewport.patch',
        id: 'wide',
        projection: { id: 'equirectangular/1', config: { horizontal: 200, vertical: 180 } },
        size: { width: 1200, height: 300, devicePixelRatio: 1 },
      },
      { type: 'viewport.patch', id: 'narrow', cameraId: 'main' },
    ];
    for (const change of changes) {
      expect(ws.dispatch(change).status).toBe('committed');
    }
    const after = layout(ws);
    // The very same records: nothing about the layout was rewritten.
    after.nodes.forEach((node, i) => {
      expect(node).toBe(before.nodes[i]);
    });
    after.surfaces.forEach((surface, i) => {
      expect(surface).toBe(before.surfaces[i]);
    });
    expect(runtime.list()).toEqual(bindings);
    expect(ws.history()).toHaveLength(1);
    expect(project('wide').fragments).not.toEqual(fragmentsBefore);
    await runtime.dispose();
  });

  it('take the projected fragments through to a planned frame', () => {
    const { ws, project } = world();
    const state = ws.getState();
    const output = project('wide');
    const frame = planFrame({
      scene: state,
      view: viewGeometryOf(state, 'wide'),
      output,
      renderer: { id: 'r/1', capabilities: MOCK_RENDERER_CAPABILITIES },
      compositor: { id: 'c/1', capabilities: MOCK_COMPOSITOR_CAPABILITIES },
      projection: equirectangular.profile,
      surfaceCapabilities: () => null,
      viewportOwns: () => true,
      geometry: (id) => ws.surfaceGeometry(id),
    });
    expect(frame.planned.map((p) => p.fragment.id).sort()).toEqual(
      output.fragments.map((f) => f.id).sort(),
    );
    const behind = frame.planned.filter((p) => p.fragment.surfaceId === 'behind');
    expect(behind.map((p) => p.fragment.nativeOwner).sort()).toEqual([false, true]);
  });

  it('refuses a view that names another projection or a configuration it rejects', () => {
    const { ws } = world();
    const view = viewGeometryOf(ws.getState(), 'wide');
    const fails = (v: ViewGeometry) => {
      try {
        projectionFor(equirectangular, v);
      } catch (error) {
        return error instanceof SwfFailure ? error.error.message : String(error);
      }
      return 'accepted';
    };
    expect(fails(view)).toBe('accepted');
    expect(fails({ ...view, projectionId: 'other/1' })).toMatch(/uses projection "other\/1"/);
    expect(fails({ ...view, projectionConfig: { horizontal: 0, vertical: 1 } })).toMatch(
      /horizontal must be/,
    );
    expect(fails({ ...view, width: 0 })).toMatch(/width and height/);
  });
});

describe('viewport views', () => {
  it('derive from the viewport and its camera, and fail on an unknown viewport', () => {
    const { ws } = world();
    const state = ws.getState();
    const view = viewGeometryOf(state, 'narrow');
    expect(view).toMatchObject({
      viewportId: 'narrow',
      width: 300,
      height: 200,
      devicePixelRatio: 1,
      near: 0.05,
      far: null,
      projectionId: 'equirectangular/1',
      projectionConfig: { horizontal: 90, vertical: 60 },
    });
    // The side camera looks along +X.
    expect(view.camera[8]).toBeCloseTo(-1, 12);
    expect(() => viewGeometryOf(state, 'none')).toThrow(SwfFailure);
  });

  it('turn heading and pitch into a camera rotation and back', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI + 1e-6, max: Math.PI, noNaN: true }),
        fc.double({ min: -Math.PI / 2 + 1e-6, max: Math.PI / 2 - 1e-6, noNaN: true }),
        (heading, pitch) => {
          const back = headingPitchOf(cameraRotation(heading, pitch));
          expect(back.heading).toBeCloseTo(heading, 9);
          expect(back.pitch).toBeCloseTo(pitch, 9);
        },
      ),
    );
    const forward = quatRotate(cameraRotation(Math.PI / 2, 0), [0, 0, -1]);
    expect(forward[0]).toBeCloseTo(1, 12);
    // Straight up, the heading is still the one turned to.
    expect(headingPitchOf(cameraRotation(0.7, Math.PI / 2)).heading).toBeCloseTo(0.7, 9);
    expect(headingPitchOf(cameraRotation(-2, -Math.PI / 2)).heading).toBeCloseTo(-2, 9);
    expect(quatSameRotation(cameraRotation(0, 0), quatFromAxisAngle([0, 1, 0], 0))).toBe(true);
    expect(() => cameraRotation(NaN, 0)).toThrow(RangeError);
  });
});

describe('picking (FR-067)', () => {
  it('returns every surface under a point as candidates, nearest first', () => {
    const ws = createWorkspace({ id: 'ws' });
    const committed = ws.transaction(
      placedCommands([
        { id: 'far', heading: 0, distance: 4 },
        { id: 'near', heading: 0, distance: 2 },
        { id: 'aside', heading: 1, distance: 2 },
      ]),
    );
    expect(committed.status).toBe('committed');
    const projection = equirectangular.create({ horizontal: 360, vertical: 120 });
    const state = ws.getState();
    const view: ViewGeometry = {
      viewportId: 'v',
      width: 800,
      height: 400,
      devicePixelRatio: 1,
      camera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      near: 0.05,
      far: null,
      projectionId: 'equirectangular/1',
      projectionConfig: { horizontal: 360, vertical: 120 },
    };
    const geometry = (id: string) => ws.surfaceGeometry(id);
    const pick = pickAt(projection, state, view, 400, 200, geometry);
    expect(pick.kind === 'hits' && pick.candidates.map((c) => [c.surfaceId, c.distance])).toEqual([
      ['near', 2],
      ['far', 4],
    ]);
    // The far limit drops what lies beyond it; a hidden owner drops its surfaces.
    const limited = pickAt(projection, state, { ...view, far: 3 }, 400, 200, geometry);
    expect(limited.kind === 'hits' && limited.candidates.map((c) => c.surfaceId)).toEqual(['near']);
    expect(
      ws.dispatch({ type: 'node.patch', id: 'n-near', flags: { selectable: false } }).status,
    ).toBe('committed');
    const after = pickAt(projection, ws.getState(), view, 400, 200, geometry);
    expect(after.kind === 'hits' && after.candidates.map((c) => c.surfaceId)).toEqual(['far']);
    expect(pickAt(projection, state, view, -1, 0, geometry).kind).toBe('outside');
  });
});
