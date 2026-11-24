import {
  ManualFrames,
  mockCapabilities,
  MockCompositor,
  MockOpaqueAdapter,
  MockRenderer,
} from '@swf/conformance';
import type { MockRendererSession } from '@swf/conformance';
import type { SceneCommand, SwfError, Workspace } from '@swf/core';
import { createWorkspace, surfaceEffectiveState, SwfFailure } from '@swf/core';
import type { PresentationHint, SurfaceCapabilities, SurfaceRuntime } from '@swf/surfaces';
import { createSurfaceRuntime } from '@swf/surfaces';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PresentationRegistry,
  PresentedViewport,
  Presenter,
  PresenterEvent,
  ProjectedFragment,
  ProjectionProfile,
  RepresentationPolicy,
  ViewportOptions,
  ViewProjector,
} from '../src/index.js';
import { createPresentationRegistry, createPresenter, fragmentId } from '../src/index.js';

const FLAT: ProjectionProfile = {
  id: 'test.flat/1',
  mapping: 'affine',
  seamWrapping: false,
  exactInverse: true,
};

const MAIN = { renderer: 'mock.renderer/1', compositor: 'mock.compositor/1' };
const SPARE = { renderer: 'spare.renderer/1', compositor: 'mock.compositor/1' };

/**
 * A flat projection for tests: a window at (x, y, z) shows as a 100×60 box centred 100 px per
 * unit from the view's centre, clipped to the view, at depth -z. Counts its projections.
 */
function flatProjector(): ViewProjector & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  return {
    profile: FLAT,
    calls,
    project(scene, view) {
      calls.set(view.viewportId, (calls.get(view.viewportId) ?? 0) + 1);
      const out: ProjectedFragment[] = [];
      for (const surface of scene.surfaces.values()) {
        const node = scene.nodes.get(surface.ownerNodeId);
        if (node === undefined || surfaceEffectiveState(scene, surface.id)?.visible !== true) {
          continue;
        }
        const [x, y, z] = node.transform.position;
        const left = view.width / 2 + x * 100 - 50;
        const top = view.height / 2 - y * 100 - 30;
        const x0 = Math.max(0, left);
        const y0 = Math.max(0, top);
        const x1 = Math.min(view.width, left + 100);
        const y1 = Math.min(view.height, top + 60);
        if (x1 <= x0 || y1 <= y0) {
          continue;
        }
        out.push({
          id: fragmentId(view.viewportId, surface.id, 0),
          surfaceId: surface.id,
          viewportId: view.viewportId,
          ordinal: 0,
          bounds: [x0, y0, x1 - x0, y1 - y0],
          corners: [
            [left, top],
            [left + 100, top],
            [left + 100, top + 60],
            [left, top + 60],
          ],
          depth: -z,
          geometricFidelity: 'exact',
          nativeOwner: true,
        });
      }
      return out;
    },
  };
}

const at = (x: number, y = 0, z = -3) => ({
  position: [x, y, z] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
});

function windowAt(id: string, x: number, y = 0, z = -3): SceneCommand[] {
  return [
    {
      type: 'node.create',
      node: { id, kind: 'window', bounds: [1, 0.6, 0.01], transform: at(x, y, z) },
    },
    {
      type: 'surface.attach',
      surface: {
        id: `${id}-s`,
        ownerNodeId: id,
        bindingKey: `key-${id}`,
        adapterTypeId: 'test.view/1',
        bounds: [1, 0.6, 0.01],
      },
    },
  ];
}

/** Lets every pending callback and promise run: frames, handoffs and bindings settle. */
/** The first of a list, which the test expects to be there. */
function first<T>(list: readonly T[]): T {
  const item = list[0];
  if (item === undefined) {
    throw new Error('the list is empty');
  }
  return item;
}

const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });

interface Harness {
  readonly ws: Workspace;
  readonly runtime: SurfaceRuntime;
  readonly adapter: MockOpaqueAdapter;
  readonly registry: PresentationRegistry;
  readonly projector: ReturnType<typeof flatProjector>;
  readonly renderer: MockRenderer;
  readonly spare: MockRenderer;
  readonly compositor: MockCompositor;
  /** Unregisters the main and the spare renderer. */
  readonly remove: { readonly main: () => void; readonly spare: () => void };
  readonly frames: ManualFrames;
  readonly presenter: Presenter;
  readonly events: PresenterEvent[];
  readonly shown: { container: unknown; error: SwfError; removed: boolean }[];
  readonly clock: { now: number };
  open(over?: Partial<ViewportOptions>): Promise<PresentedViewport>;
}

let current: Harness | null = null;
afterEach(async () => {
  await current?.presenter.dispose();
  await current?.runtime.dispose();
  current = null;
});

async function harness(
  options: {
    windows?: readonly SceneCommand[];
    capabilities?: SurfaceCapabilities;
    budgetMs?: number;
  } = {},
): Promise<Harness> {
  const ws = createWorkspace({
    id: 'ws',
    projectionKinds: [{ id: FLAT.id, configIssue: () => null }],
  });
  const viewport = (id: string, cameraId: string): SceneCommand => ({
    type: 'viewport.create',
    viewport: {
      id,
      cameraId,
      projection: { id: FLAT.id, config: {} },
      size: { width: 800, height: 400, devicePixelRatio: 1 },
    },
  });
  const result = ws.transaction([
    { type: 'camera.create', camera: { id: 'cam' } },
    { type: 'camera.create', camera: { id: 'cam2' } },
    viewport('v', 'cam'),
    viewport('w', 'cam2'),
    ...(options.windows ?? [...windowAt('a', -2), ...windowAt('b', 0), ...windowAt('c', 2)]),
  ]);
  if (result.status !== 'committed') {
    throw new Error(`fixture failed: ${JSON.stringify(result)}`);
  }
  const runtime = createSurfaceRuntime(ws);
  const adapter = new MockOpaqueAdapter('test.view/1', options.capabilities);
  runtime.registerAdapter(adapter);
  await settle();
  const registry = createPresentationRegistry();
  const projector = flatProjector();
  registry.registerProjector(projector);
  const renderer = new MockRenderer();
  const spare = new MockRenderer('spare.renderer/1');
  const compositor = new MockCompositor();
  const remove = {
    main: registry.registerRenderer(renderer),
    spare: registry.registerRenderer(spare),
  };
  registry.registerCompositor(compositor);
  const frames = new ManualFrames();
  const clock = { now: 0 };
  const shown: Harness['shown'] = [];
  const presenter = createPresenter({
    workspace: ws,
    runtime,
    registry,
    frames,
    now: () => clock.now,
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    showDegraded: (container, error) => {
      const entry = { container, error, removed: false };
      shown.push(entry);
      return () => {
        entry.removed = true;
      };
    },
  });
  const events: PresenterEvent[] = [];
  presenter.subscribe((event) => events.push(event));
  const h: Harness = {
    ws,
    runtime,
    adapter,
    registry,
    projector,
    renderer,
    spare,
    compositor,
    remove,
    frames,
    presenter,
    events,
    shown,
    clock,
    open: (over = {}) =>
      presenter.open({
        viewportId: 'v',
        container: { host: over.viewportId ?? 'v' },
        backends: [MAIN, SPARE],
        ...over,
      }),
  };
  current = h;
  return h;
}

const frames = (events: readonly PresenterEvent[], viewportId = 'v') =>
  events.filter(
    (e): e is Extract<PresenterEvent, { type: 'frame' }> =>
      e.type === 'frame' && e.viewportId === viewportId,
  );

const move = (id: string, x: number, y = 0, z = -3): SceneCommand => ({
  type: 'node.patch',
  id,
  transform: at(x, y, z),
});

function hintsTo(adapter: MockOpaqueAdapter, surfaceId: string): PresentationHint[] {
  return adapter.calls.flatMap((c) =>
    c.method === 'update' && c.hint?.surfaceId === surfaceId ? [c.hint] : [],
  );
}

/** Where the adapter last attached a surface: the container of its last attach. */
function attachedTo(adapter: MockOpaqueAdapter, key: string): unknown {
  return adapter.calls.filter((c) => c.method === 'attach' && c.handle?.key === key).at(-1)?.target
    ?.container;
}

describe('frames at frame boundaries (FR-143, FR-148, NFR-005, NFR-009)', () => {
  it('presents a viewport once per frame boundary with the latest state, never a backlog', async () => {
    const h = await harness();
    await h.open();
    await h.frames.flush();
    expect(frames(h.events)).toHaveLength(1);
    // Many changes between two boundaries ask for one frame, which shows the last of them.
    for (let x = 0; x < 20; x++) {
      h.ws.dispatch(move('a', x / 10));
    }
    expect(h.frames.pending).toBe(1);
    await h.frames.flush();
    const last = frames(h.events).at(-1);
    expect(frames(h.events)).toHaveLength(2);
    expect(last?.metrics.dirty).toEqual(['scene']);
    expect(last?.metrics.sceneRevision).toBe(h.ws.getState().revision);
    expect(
      h.presenter.viewport('v')?.lastFrame()?.frame.output.fragmentsOf('a-s')[0]?.bounds[0],
    ).toBe(400 + 190 - 50);
    // Nothing changed: no frame is asked for, and none happens.
    expect(h.frames.pending).toBe(0);
    await h.frames.flush();
    expect(frames(h.events)).toHaveLength(2);
  });

  it('re-projects a viewport only when what it shows changed, not for another viewport’s camera', async () => {
    const h = await harness();
    await h.open();
    await h.open({ viewportId: 'w' });
    await h.frames.flush();
    const projected = { v: h.projector.calls.get('v'), w: h.projector.calls.get('w') };
    h.ws.dispatch({ type: 'camera.patch', id: 'cam2', position: [0, 1, 0] });
    await h.frames.flush();
    expect(h.projector.calls.get('v')).toBe(projected.v);
    expect(h.projector.calls.get('w')).toBe((projected.w ?? 0) + 1);
    expect(frames(h.events, 'v')).toHaveLength(1);
    expect(frames(h.events, 'w').at(-1)?.metrics.dirty).toEqual(['view']);
    // A frame asked for without a change re-plans but does not re-project.
    h.presenter.viewport('v')?.invalidate();
    await h.frames.flush();
    expect(h.projector.calls.get('v')).toBe(projected.v);
    expect(frames(h.events, 'v').at(-1)?.metrics.dirty).toEqual(['requested']);
  });

  it('shows open previews without committing them', async () => {
    const h = await harness();
    const v = await h.open();
    await h.frames.flush();
    h.ws.preview('drag', [move('b', 1)], { source: 'user' });
    await h.frames.flush();
    expect(v.lastFrame()?.frame.output.fragmentsOf('b-s')[0]?.bounds[0]).toBe(400 + 100 - 50);
    expect(h.ws.getState().nodes.get('b')?.transform.position).toEqual([0, 0, -3]);
    h.ws.cancelPreview('drag', 'escape');
    await h.frames.flush();
    expect(v.lastFrame()?.frame.output.fragmentsOf('b-s')[0]?.bounds[0]).toBe(400 - 50);
  });

  it('serves interactive viewports first and background ones while the budget lasts', async () => {
    const h = await harness({ budgetMs: 8 });
    const slow = h.projector.project.bind(h.projector);
    // Each projection takes 10 ms on the test clock.
    h.projector.project = (...args) => {
      h.clock.now += 10;
      return slow(...args);
    };
    await h.open({ viewportId: 'w', priority: 'background' });
    await h.open();
    await h.frames.flush();
    // The interactive viewport went first; the background one was out of budget, and waits.
    expect(frames(h.events, 'v')).toHaveLength(1);
    expect(frames(h.events, 'w')).toHaveLength(0);
    expect(h.frames.pending).toBe(1);
    await h.frames.flush();
    expect(frames(h.events, 'w')).toHaveLength(1);
    expect(frames(h.events, 'w')[0]?.metrics.skipped).toBe(1);
    expect(frames(h.events, 'w')[0]?.metrics.durationMs).toBe(10);
  });
});

describe('advisory hints (FR-045, FR-046, FR-141, FR-149, AC-006)', () => {
  it('keeps visibility, mounting, the scene flag, intersection, occlusion and attention apart', async () => {
    const h = await harness({
      windows: [...windowAt('a', 0), ...windowAt('b', 0.5, 0, -2), ...windowAt('c', 3.7)],
    });
    h.ws.dispatch({ type: 'focus.set', id: 'b' });
    await h.open();
    await h.frames.flush();
    const a = hintsTo(h.adapter, 'a-s').at(-1);
    const b = hintsTo(h.adapter, 'b-s').at(-1);
    const c = hintsTo(h.adapter, 'c-s').at(-1);
    expect(a).toMatchObject({
      visible: true,
      mounted: true,
      sceneVisible: true,
      intersectionRatio: 1,
      tier: 'full',
      attention: 'context',
    });
    // b is in front of half of a: a's occlusion is estimated, b's is exactly none.
    expect(a?.occlusion.confidence).toBe('estimated');
    expect(a?.occlusion.value).toBeCloseTo(0.5);
    expect(b).toMatchObject({ occlusion: { value: 0, confidence: 'exact' }, attention: 'active' });
    // c sticks out of the view: shown, partly.
    expect(c?.intersectionRatio).toBeCloseTo(0.8);
    expect(c?.projectedBounds).toEqual([720, 170, 80, 60]);
  });

  it('only hints when a surface is hidden or far away, never touching its producer', async () => {
    const h = await harness();
    const v = await h.open();
    await h.frames.flush();
    const lifecycle = () =>
      h.adapter.methods().filter((m) => m !== 'update' && m !== 'capabilities');
    const before = lifecycle();
    // Far away: still shown and mounted, smaller on screen.
    h.ws.dispatch(move('a', -2, 0, -300));
    await h.frames.flush();
    expect(hintsTo(h.adapter, 'a-s').at(-1)).toMatchObject({ visible: true, mounted: true });
    // Hidden in the scene: the surface is hidden here and told so.
    h.ws.dispatch({ type: 'node.patch', id: 'a', flags: { visible: false } });
    await h.frames.flush();
    expect(hintsTo(h.adapter, 'a-s').at(-1)).toMatchObject({
      visible: false,
      mounted: false,
      sceneVisible: false,
      tier: 'hidden',
      occlusion: { value: null, confidence: 'unknown' },
    });
    expect(v.presentation('a-s')).toBe('proxy');
    expect(h.runtime.get('a-s')?.state).toBe('hidden');
    // Nothing but hints reached the adapter, and its producer was never touched.
    expect(lifecycle()).toEqual(before);
    expect(h.adapter.producerTouched).toBe(0);
  });

  it('coalesces repeated hints: an unchanged frame delivers none', async () => {
    const h = await harness();
    const v = await h.open();
    await h.frames.flush();
    expect(frames(h.events)[0]?.metrics.hints).toBe(3);
    v.invalidate();
    await h.frames.flush();
    expect(frames(h.events).at(-1)?.metrics.hints).toBe(0);
  });
});

describe('representation policies (FR-122, ARCH-025)', () => {
  /** Full nearer than 4 units, compact to 6, the label beyond: by each window's depth. */
  const byDepth: RepresentationPolicy = {
    id: 'test.depth/1',
    representationOf({ scene, nodeId }) {
      const depth = -(scene.nodes.get(nodeId)?.transform.position[2] ?? 0);
      return depth < 4 ? 'full' : depth < 6 ? 'compact' : 'label';
    },
  };

  it('represents each surface as the policy chooses, following the scene, never touching producers', async () => {
    const h = await harness();
    const v = await h.open();
    await h.frames.flush();
    const lifecycle = () =>
      h.adapter.methods().filter((m) => m !== 'update' && m !== 'capabilities');
    const before = lifecycle();
    expect(['a-s', 'b-s', 'c-s'].map((s) => v.presentation(s))).toEqual(['live', 'live', 'live']);
    v.setRepresentation(byDepth);
    expect(v.representation()).toBe(byDepth);
    // Nothing changed in the scene: setting the policy alone makes a frame due.
    h.ws.dispatch(move('b', 0, 0, -5));
    h.ws.dispatch(move('c', 2, 0, -8));
    await h.frames.flush();
    expect(frames(h.events).at(-1)?.metrics.dirty).toEqual(
      expect.arrayContaining(['representation']),
    );
    expect(['a-s', 'b-s', 'c-s'].map((s) => v.presentation(s))).toEqual(['live', 'proxy', 'proxy']);
    const planned = v.lastFrame()?.frame.planned ?? [];
    expect(
      planned.map((p) => [p.fragment.surfaceId, p.representation, p.negotiation.layer]),
    ).toEqual(
      expect.arrayContaining([
        ['a-s', 'full', 'content-native'],
        ['b-s', 'compact', 'proxy'],
        ['c-s', 'label', 'proxy'],
      ]),
    );
    // The represented surfaces are no fallbacks: only a's live element falls short of exact.
    expect(v.lastFrame()?.frame.fallbacks.map((f) => f.surfaceId)).toEqual(['a-s']);
    expect(hintsTo(h.adapter, 'b-s').at(-1)).toMatchObject({
      visible: true,
      mounted: false,
      tier: 'compact',
    });
    expect(hintsTo(h.adapter, 'c-s').at(-1)).toMatchObject({
      visible: true,
      mounted: false,
      tier: 'proxy',
    });
    // Represented, the endpoints stay bound and attached here, only hidden.
    expect(h.runtime.get('b-s')?.state).toBe('hidden');
    expect(h.runtime.get('c-s')?.viewports).toEqual([{ viewportId: 'v', visible: false }]);
    // Brought nearer, a window is shown in full again.
    h.ws.dispatch(move('b', 0, 0, -3));
    await h.frames.flush();
    expect(v.presentation('b-s')).toBe('live');
    // Without the policy, every surface is shown in full.
    v.setRepresentation(null);
    await h.frames.flush();
    expect(['a-s', 'b-s', 'c-s'].map((s) => v.presentation(s))).toEqual(['live', 'live', 'live']);
    // Only presentation and hints reached the adapter: never a release, never the producer.
    expect(
      lifecycle()
        .slice(before.length)
        .every((m) => m === 'attach' || m === 'hide'),
    ).toBe(true);
    expect(h.adapter.methods()).not.toContain('release');
    expect(h.adapter.producerTouched).toBe(0);
  });

  it('refuses something that is no representation policy, keeping the one it follows', async () => {
    const h = await harness();
    const v = await h.open();
    v.setRepresentation(byDepth);
    for (const bad of [
      { id: 'no version', representationOf: () => 'full' },
      { id: 'test.depth/2' },
      null as unknown,
    ]) {
      if (bad === null) {
        continue;
      }
      expect(() => {
        v.setRepresentation(bad as RepresentationPolicy);
      }).toThrow(SwfFailure);
    }
    expect(v.representation()).toBe(byDepth);
  });
});

describe('virtualization (FR-150, BR-014, NFR-018)', () => {
  it('keeps the most important surfaces live up to the limit and shows the rest as proxies', async () => {
    const h = await harness();
    h.ws.dispatch({ type: 'focus.set', id: 'c' });
    const v = await h.open({ maxLive: 1 });
    await h.frames.flush();
    expect(['a-s', 'b-s', 'c-s'].map((s) => v.presentation(s))).toEqual(['proxy', 'proxy', 'live']);
    const layers = v
      .lastFrame()
      ?.rendered.layers.map((l) => `${String(l.surfaceId)}:${l.category}`);
    expect(layers).toEqual(
      expect.arrayContaining(['a-s:proxy', 'b-s:proxy', 'c-s:content-native']),
    );
    expect(
      h.runtime
        .list()
        .filter((p) => p.viewports.length > 0)
        .map((p) => p.surfaceId),
    ).toEqual(['c-s']);
    // Focus moves on: c gives way to b. Still attached here, c is shown but no longer mounted.
    h.ws.dispatch({ type: 'focus.set', id: 'b' });
    await h.frames.flush();
    expect(['b-s', 'c-s'].map((s) => v.presentation(s))).toEqual(['live', 'proxy']);
    expect(hintsTo(h.adapter, 'c-s').at(-1)).toMatchObject({
      visible: true,
      mounted: false,
      tier: 'proxy',
      attention: 'context',
    });
    expect(h.runtime.get('c-s')?.viewports).toEqual([{ viewportId: 'v', visible: false }]);
  });

  it('releases what leaves the view only when the endpoint declares safe detachment', async () => {
    const safe = await harness();
    const v = await safe.open({ release: true });
    await safe.frames.flush();
    safe.ws.dispatch(move('a', -20));
    await safe.frames.flush();
    expect(v.lastFrame()?.hidden).toEqual(['a-s']);
    expect(safe.runtime.get('a-s')).toMatchObject({ state: 'ready', viewports: [] });
    await safe.presenter.dispose();
    await safe.runtime.dispose();

    const unsafe = await harness({
      capabilities: mockCapabilities({ safeDetach: false, rebinding: false }),
    });
    await unsafe.open({ release: true });
    await unsafe.frames.flush();
    unsafe.ws.dispatch(move('a', -20));
    await unsafe.frames.flush();
    // It stays attached, hidden: the endpoint stays the host's, and nothing was detached.
    expect(unsafe.runtime.get('a-s')).toMatchObject({
      state: 'hidden',
      viewports: [{ viewportId: 'v', visible: false }],
    });
    expect(unsafe.adapter.methods()).not.toContain('detach');
  });
});

describe('backend handoff (FR-087, API-007, §13.5)', () => {
  it('prepares, validates, rebuilds, moves live content, activates and releases the old one', async () => {
    const h = await harness();
    const v = await h.open();
    await h.frames.flush();
    const oldSession = first(h.renderer.sessions);
    const states: string[] = [];
    const prepare = h.spare.prepare.bind(h.spare);
    h.spare.prepare = (scene, view) => {
      states.push(v.state);
      return prepare(scene, view);
    };
    const outcome = await v.switchBackend(SPARE);
    expect(outcome).toEqual({ status: 'switched', backend: SPARE });
    expect(states).toEqual(['preparing']);
    expect(v.state).toBe('active');
    expect(v.backend).toEqual(SPARE);
    expect(oldSession.released).toBe(1);
    expect(oldSession.lossWatchers).toBe(0);
    // The live content was moved into the new resources, not mounted twice.
    const newSession = first(h.spare.sessions);
    expect(attachedTo(h.adapter, 'key-a')).toBe(newSession.targetOf('a-s'));
    expect(h.runtime.get('a-s')?.viewports).toEqual([{ viewportId: 'v', visible: true }]);
    expect(v.presentation('a-s')).toBe('live');
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'backend.switched',
        from: MAIN,
        to: SPARE,
        reason: 'requested',
      }),
    );
    await h.frames.flush();
    expect(frames(h.events).at(-1)?.metrics).toMatchObject({
      rendererId: SPARE.renderer,
      dirty: ['backend'],
    });
  });

  it('keeps the previous backend when preparing, validating or swapping fails', async () => {
    const h = await harness();
    const v = await h.open();
    await h.frames.flush();
    const oldSession = first(h.renderer.sessions);
    const target = oldSession.targetOf('a-s');

    // Preparing: the new renderer cannot be prepared.
    h.spare.failPrepare = 'no context';
    expect(await v.switchBackend(SPARE)).toMatchObject({
      status: 'kept',
      backend: MAIN,
      error: {
        code: 'BACKEND_SWITCH_FAILED',
        details: { phase: 'preparing', reason: 'no context' },
      },
    });
    h.spare.failPrepare = null;

    // Validating: the scene cannot be planned with it.
    const failing = h.spare.prepare.bind(h.spare);
    h.spare.prepare = async (scene, view) => {
      const session = (await failing(scene, view)) as MockRendererSession;
      session.failRender = 'cannot render';
      return session;
    };
    expect(await v.switchBackend(SPARE)).toMatchObject({
      status: 'kept',
      error: { details: { phase: 'swapping', reason: 'cannot render' } },
    });
    h.spare.prepare = failing;

    // Swapping: moving the live content into it fails; it goes back where it was.
    const attach = h.adapter.attach.bind(h.adapter);
    h.adapter.attach = (handle, t) =>
      t.container === target ? attach(handle, t) : Promise.reject(new Error('no room'));
    expect(await v.switchBackend(SPARE)).toMatchObject({
      status: 'kept',
      error: { details: { phase: 'swapping' } },
    });
    h.adapter.attach = attach;
    expect(attachedTo(h.adapter, 'key-a')).toBe(target);

    // Swapping, with several live surfaces: the last one cannot move, so those moved before it
    // are moved back.
    const targets = ['a-s', 'b-s', 'c-s'].map((s) => oldSession.targetOf(s));
    h.adapter.attach = (handle, t) =>
      handle.key === 'key-c' && !targets.includes(t.container)
        ? Promise.reject(new Error('no room'))
        : attach(handle, t);
    expect(await v.switchBackend(SPARE)).toMatchObject({ status: 'kept' });
    h.adapter.attach = attach;
    expect(['key-a', 'key-b', 'key-c'].map((k) => attachedTo(h.adapter, k))).toEqual(targets);

    // Through it all the old backend kept presenting, and every new session was released.
    expect(oldSession.released).toBe(0);
    expect(v.backend).toEqual(MAIN);
    expect(h.spare.sessions.every((s) => s.released === 1)).toBe(true);
    h.ws.dispatch(move('b', 1));
    expect((await v.update()).status).toBe('presented');
    expect(h.events.filter((e) => e.type === 'backend.failed')).toHaveLength(4);
  });

  it('refuses a switch that would strand content its endpoint cannot detach safely', async () => {
    const h = await harness({
      capabilities: mockCapabilities({ safeDetach: false, rebinding: false }),
    });
    const v = await h.open();
    await h.frames.flush();
    expect(await v.switchBackend(SPARE)).toMatchObject({
      status: 'kept',
      error: {
        details: { phase: 'validating' },
        message: expect.stringMatching(/does not allow safe detachment/) as unknown,
      },
    });
    expect(h.adapter.methods()).not.toContain('detach');
  });
});

describe('fallback, loss and degradation (§27, NFR-013, §33.2 scenario 6)', () => {
  it('falls back when the renderer in use is removed, degrades when none is left, and comes back', async () => {
    const h = await harness();
    const v = await h.open({ backends: [MAIN, SPARE] });
    await h.frames.flush();
    expect(v.backend).toEqual(MAIN);
    // Remove the renderer: the viewport falls back to the spare one.
    h.remove.main();
    await settle();
    expect(v.backend).toEqual(SPARE);
    expect(v.presentation('a-s')).toBe('live');
    // Remove that one too: nothing is left, and the viewport shows that it is degraded.
    h.remove.spare();
    await settle();
    expect(v.state).toBe('presentation-degraded');
    expect(v.backend).toBeNull();
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]?.container).toEqual({ host: 'v' });
    expect(h.shown[0]?.error.code).toBe('BACKEND_SWITCH_FAILED');
    expect(await v.update()).toMatchObject({
      status: 'degraded',
      error: { code: 'BACKEND_SWITCH_FAILED' },
    });
    expect(v.presentation('a-s')).toBe('proxy');
    // The scene stays fully usable meanwhile, and nothing of the layout is lost.
    expect(h.ws.dispatch(move('b', 1.5)).status).toBe('committed');
    // The preferred renderer comes back: the viewport returns to it and to live content.
    h.registry.registerRenderer(h.renderer);
    await settle();
    expect(v.state).toBe('active');
    expect(v.backend).toEqual(MAIN);
    expect(h.shown[0]?.removed).toBe(true);
    await h.frames.flush();
    expect(v.presentation('a-s')).toBe('live');
    expect(v.lastFrame()?.frame.output.fragmentsOf('b-s')[0]?.bounds[0]).toBe(400 + 150 - 50);
  });

  it('replaces a backend that lost its resources and tries it again only when restored', async () => {
    const h = await harness();
    const v = await h.open();
    await h.frames.flush();
    const lost = first(h.compositor.sessions);
    lost.lose('the GPU went away');
    await settle();
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'backend.lost', backend: MAIN, reason: 'the GPU went away' }),
    );
    expect(v.backend).toEqual(SPARE);
    expect(lost.released).toBe(1);
    // Registering something else does not bring back what was lost here.
    h.registry.registerRenderer(new MockRenderer('third.renderer/1'));
    await settle();
    expect(v.backend).toEqual(SPARE);
    expect(await v.restore()).toEqual({ status: 'switched', backend: MAIN });
    expect(v.backend).toEqual(MAIN);
  });

  it('opens degraded when no backend works, and recovers on restore', async () => {
    const h = await harness();
    h.renderer.failPrepare = 'no';
    h.spare.failPrepare = 'no';
    const v = await h.open();
    expect(v.state).toBe('presentation-degraded');
    expect(h.events.filter((e) => e.type === 'backend.failed')).toHaveLength(2);
    h.renderer.failPrepare = null;
    expect(await v.restore()).toEqual({ status: 'switched', backend: MAIN });
    expect(h.shown[0]?.removed).toBe(true);
  });
});

describe('presenter contract', () => {
  it('validates its options, naming the field', async () => {
    const h = await harness();
    const bad = (options: object) => () =>
      createPresenter({
        workspace: h.ws,
        runtime: h.runtime,
        registry: h.registry,
        frames: h.frames,
        showDegraded: () => () => undefined,
        ...options,
      });
    expect(bad({ budgetMs: 0 })).toThrow(/budgetMs/);
    expect(bad({ frames: {} })).toThrow(/frames/);
    expect(bad({ showDegraded: null })).toThrow(/showDegraded/);
    await expect(h.open({ backends: [] })).rejects.toThrow(/backends must be a non-empty array/);
    await expect(h.open({ maxLive: -1 })).rejects.toThrow(/maxLive/);
    await expect(h.open({ viewportId: 'nope' })).rejects.toMatchObject({
      error: { code: 'UNKNOWN_ENTITY' },
    });
    await h.open();
    await expect(h.open()).rejects.toThrow(SwfFailure);
  });

  it('isolates a throwing listener and keeps it in its diagnostics', async () => {
    const h = await harness();
    h.presenter.subscribe(() => {
      throw new Error('listener bug');
    });
    await h.open();
    await h.frames.flush();
    expect(frames(h.events)).toHaveLength(1);
    expect(h.presenter.getDiagnostics()).toContainEqual(
      expect.objectContaining({ code: 'LISTENER_THREW', details: { reason: 'listener bug' } }),
    );
  });

  it('releases everything it holds when disposed', async () => {
    const h = await harness();
    const v = await h.open();
    await h.frames.flush();
    expect(h.presenter.resources()).toMatchObject({ viewports: 1, sessions: 2 });
    h.ws.dispatch(move('a', 1));
    await h.presenter.dispose();
    expect(h.presenter.resources()).toEqual({
      viewports: 0,
      sessions: 0,
      listeners: 0,
      subscriptions: 0,
      frameRequested: false,
    });
    expect(h.renderer.sessions[0]?.released).toBe(1);
    expect(h.runtime.list().every((p) => p.viewports.length === 0)).toBe(true);
    await expect(v.update()).rejects.toThrow(/disposed/);
    expect(h.frames.pending).toBe(0);
  });
});
