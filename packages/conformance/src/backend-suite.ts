import type { Id, SceneState, Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import type {
  Compositor,
  ProjectedFragment,
  ProjectionProfile,
  RenderedFrame,
  RendererBackend,
  RenderFrame,
  ViewGeometry,
} from '@swf/presentation';
import {
  createPresentationRegistry,
  createViewOutput,
  fragmentId,
  planFrame,
} from '@swf/presentation';
import type { SurfaceCapabilities } from '@swf/surfaces';
import type { ConformanceCase } from './harness.js';
import { check } from './harness.js';
import { mockCapabilities } from './mock-adapter.js';

/** What the backend suite needs: fresh renderers and compositors, and a container per viewport. */
export interface BackendFixture {
  renderer(): RendererBackend;
  compositor(): Compositor;
  container?(viewportId: Id): unknown;
}

const VIEWPORT = 'conformance-view';

const PROFILES: readonly ProjectionProfile[] = [
  Object.freeze({
    id: 'conformance.perspective/1',
    mapping: 'affine',
    seamWrapping: false,
    exactInverse: true,
  }),
  Object.freeze({
    id: 'conformance.panorama/1',
    mapping: 'nonlinear',
    seamWrapping: true,
    exactInverse: true,
  }),
];

/** The kinds of surface every backend must handle, each by its capabilities (null: unbound). */
const SURFACES: readonly {
  readonly id: Id;
  readonly capabilities: SurfaceCapabilities | null;
  readonly fragments: number;
}[] = [
  // A live single-owner element crossing a seam: two fragments, one of them the native owner.
  { id: 'live', capabilities: mockCapabilities(), fragments: 2 },
  {
    id: 'drawn',
    capabilities: mockCapabilities({
      attachStrategy: 'drawable',
      nativeInteraction: 'none',
      transformFidelity: 'exact',
      viewportSharing: 'shared',
    }),
    fragments: 1,
  },
  {
    id: 'proxied',
    capabilities: mockCapabilities({
      attachStrategy: 'proxy-only',
      nativeInteraction: 'none',
      transformFidelity: 'proxy',
      uvAddressing: false,
      cursorMapping: false,
    }),
    fragments: 1,
  },
  { id: 'unbound', capabilities: null, fragments: 1 },
];

function scene(): Workspace {
  const workspace = createWorkspace({ id: 'conformance' });
  const result = workspace.transaction([
    { type: 'node.create', node: { id: 'w', kind: 'window', bounds: [4, 2, 0.01] } },
    ...SURFACES.map((s, i) => ({
      type: 'surface.attach' as const,
      surface: {
        id: s.id,
        ownerNodeId: 'w',
        bindingKey: s.capabilities === null ? null : `key-${s.id}`,
        adapterTypeId: 'conformance.view/1',
        bounds: [1, 0.5, 0.01] as const,
        transform: {
          position: [i - 1.5, 0, 0] as const,
          rotation: [0, 0, 0, 1] as const,
          scale: [1, 1, 1] as const,
        },
      },
    })),
  ]);
  check(result.status === 'committed', 'the conformance scene could not be built');
  return workspace;
}

function fragments(order: 'forward' | 'reverse'): ProjectedFragment[] {
  const out: ProjectedFragment[] = [];
  SURFACES.forEach((s, i) => {
    for (let ordinal = 0; ordinal < s.fragments; ordinal++) {
      out.push(
        Object.freeze({
          id: fragmentId(VIEWPORT, s.id, ordinal),
          surfaceId: s.id,
          viewportId: VIEWPORT,
          ordinal,
          bounds: [100 * i + 600 * ordinal, 50, 90, 45] as const,
          corners: null,
          depth: 3 + (i % 2),
          geometricFidelity: 'exact',
          nativeOwner: ordinal === 0,
        }),
      );
    }
  });
  return order === 'forward' ? out : out.reverse();
}

function view(profile: ProjectionProfile): ViewGeometry {
  return Object.freeze({
    viewportId: VIEWPORT,
    width: 1280,
    height: 720,
    devicePixelRatio: 1,
    camera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const,
    near: 0.05,
    far: null,
    projectionId: profile.id,
    projectionConfig: null,
  });
}

function plan(
  workspace: Workspace,
  state: SceneState,
  renderer: RendererBackend,
  compositor: Compositor,
  profile: ProjectionProfile,
  order: 'forward' | 'reverse' = 'forward',
): RenderFrame {
  const capabilities = new Map(SURFACES.map((s) => [s.id, s.capabilities]));
  return planFrame({
    scene: state,
    view: view(profile),
    output: createViewOutput(state, VIEWPORT, fragments(order)),
    renderer: { id: renderer.id, capabilities: renderer.capabilities() },
    compositor: { id: compositor.id, capabilities: compositor.capabilities() },
    projection: profile,
    surfaceCapabilities: (id) => capabilities.get(id) ?? null,
    viewportOwns: () => true,
    geometry: (id) => workspace.surfaceGeometry(id),
  });
}

function layerSignature(frame: RenderedFrame): string {
  return frame.layers.map((l) => `${l.id}@${l.category}`).join(' ');
}

/**
 * The renderer and compositor conformance cases that the contracts fix: valid registration,
 * sessions bound to their viewport, every planned fragment realized exactly once in the layer its
 * negotiation chose (so fragment IDs map back to one surface), no live element mounted twice, a
 * deterministic order that follows the plan, composition that keeps that order, an unchanged
 * scene, and idempotent release.
 */
export function backendConformance(fixture: BackendFixture): ConformanceCase[] {
  const target = (viewportId: Id) => ({
    viewportId,
    container: fixture.container?.(viewportId) ?? {},
  });
  const prepared = async (profile: ProjectionProfile) => {
    const workspace = scene();
    const state = workspace.getState();
    const renderer = fixture.renderer();
    const compositor = fixture.compositor();
    const rendererSession = await renderer.prepare(state, view(profile));
    const compositorSession = await compositor.prepare(target(VIEWPORT), rendererSession);
    return { workspace, state, renderer, compositor, rendererSession, compositorSession };
  };
  const forEachProfile = (
    name: string,
    body: (profile: ProjectionProfile) => Promise<void>,
  ): ConformanceCase => ({
    name,
    async run() {
      for (const profile of PROFILES) {
        await body(profile);
      }
      return 'passed';
    },
  });
  return [
    {
      name: 'registers a renderer and a compositor with versioned contracts and valid capabilities',
      run() {
        const registry = createPresentationRegistry();
        registry.registerRenderer(fixture.renderer());
        registry.registerCompositor(fixture.compositor());
        return Promise.resolve('passed');
      },
    },
    forEachProfile('prepares sessions bound to their viewport', async () => {
      const p = await prepared(PROFILES[0] ?? fail());
      check(
        p.rendererSession.viewportId === VIEWPORT,
        'the renderer session names another viewport',
      );
      check(
        p.rendererSession.rendererId === p.renderer.id,
        'the renderer session names another renderer',
      );
      check(
        p.compositorSession.viewportId === VIEWPORT,
        'the compositor session names another viewport',
      );
      check(
        p.compositorSession.compositorId === p.compositor.id,
        'the compositor session names another compositor',
      );
      await release(p);
    }),
    forEachProfile(
      'realizes every planned fragment exactly once, in the layer its negotiation chose',
      async (profile) => {
        const p = await prepared(profile);
        const frame = plan(p.workspace, p.state, p.renderer, p.compositor, profile);
        const rendered = p.rendererSession.render(frame);
        for (const planned of frame.planned) {
          const layers = rendered.layers.filter((l) => l.fragmentId === planned.fragment.id);
          check(
            layers.length === 1,
            `fragment "${planned.fragment.id}" was realized ${String(layers.length)} times`,
          );
          const [layer] = layers;
          check(
            layer?.category === planned.negotiation.layer,
            `fragment "${planned.fragment.id}" went in a ${String(layer?.category)} layer, but negotiation chose ${planned.negotiation.layer}`,
          );
          check(
            layer.surfaceId === frame.output.surfaceOf(planned.fragment.id),
            `the layer of fragment "${planned.fragment.id}" names surface "${String(layer.surfaceId)}"`,
          );
        }
        const ids = rendered.layers.map((l) => l.id);
        check(new Set(ids).size === ids.length, 'two layers share an ID');
        const unknown = rendered.layers.find(
          (l) => l.fragmentId !== null && frame.output.surfaceOf(l.fragmentId) === undefined,
        );
        check(
          unknown === undefined,
          `a layer refers to unknown fragment "${String(unknown?.fragmentId)}"`,
        );
        await release(p);
      },
    ),
    forEachProfile('never mounts one surface’s live element twice', async (profile) => {
      const p = await prepared(profile);
      const rendered = p.rendererSession.render(
        plan(p.workspace, p.state, p.renderer, p.compositor, profile),
      );
      const live = rendered.layers.filter((l) => l.category === 'content-native');
      const surfaces = live.map((l) => l.surfaceId);
      check(
        new Set(surfaces).size === surfaces.length,
        'a surface has more than one native content layer',
      );
      await release(p);
    }),
    forEachProfile('orders layers by the plan, the same way every time', async (profile) => {
      const p = await prepared(profile);
      const frame = plan(p.workspace, p.state, p.renderer, p.compositor, profile);
      const once = p.rendererSession.render(frame);
      const twice = p.rendererSession.render(frame);
      check(layerSignature(once) === layerSignature(twice), 'the same frame rendered differently');
      const shuffled = p.rendererSession.render(
        plan(p.workspace, p.state, p.renderer, p.compositor, profile, 'reverse'),
      );
      check(
        layerSignature(once) === layerSignature(shuffled),
        'the order depends on the order fragments were supplied in',
      );
      const planOrder = frame.planned.map((pl) => pl.fragment.id);
      const layerOrder = once.layers.flatMap((l) => (l.fragmentId === null ? [] : [l.fragmentId]));
      check(
        planOrder.join(' ') === layerOrder.join(' '),
        'content layers do not follow the plan order',
      );
      await release(p);
    }),
    forEachProfile(
      'composes every layer once, keeping the rendered order when ordering is explicit',
      async (profile) => {
        const p = await prepared(profile);
        const rendered = p.rendererSession.render(
          plan(p.workspace, p.state, p.renderer, p.compositor, profile),
        );
        const composed = p.compositorSession.compose(rendered);
        const ids = rendered.layers.map((l) => l.id);
        check(
          [...composed.order].sort().join(' ') === [...ids].sort().join(' '),
          'the composed frame does not hold each rendered layer exactly once',
        );
        if (p.compositor.capabilities().ordering === 'explicit') {
          check(
            composed.order.join(' ') === ids.join(' '),
            'an explicit-ordering compositor changed the order',
          );
        }
        check(
          composed.sceneRevision === rendered.sceneRevision,
          'the composed frame names another revision',
        );
        await release(p);
      },
    ),
    forEachProfile('leaves the scene unchanged', async (profile) => {
      const p = await prepared(profile);
      const before = p.workspace.getState();
      const rendered = p.rendererSession.render(
        plan(p.workspace, p.state, p.renderer, p.compositor, profile),
      );
      p.compositorSession.compose(rendered);
      check(p.workspace.getState() === before, 'rendering changed the scene');
      await release(p);
    }),
    {
      name: 'releases sessions more than once safely and refuses to render after release',
      async run() {
        const profile = PROFILES[0] ?? fail();
        const p = await prepared(profile);
        await release(p);
        await release(p);
        let refused = false;
        try {
          p.rendererSession.render(plan(p.workspace, p.state, p.renderer, p.compositor, profile));
        } catch {
          refused = true;
        }
        check(refused, 'a released renderer session still rendered');
        return 'passed';
      },
    },
  ];
}

async function release(p: {
  readonly rendererSession: { release(): Promise<void> };
  readonly compositorSession: { release(): Promise<void> };
}): Promise<void> {
  await p.compositorSession.release();
  await p.rendererSession.release();
}

function fail(): never {
  throw new Error('the conformance suite has no projection profiles');
}
