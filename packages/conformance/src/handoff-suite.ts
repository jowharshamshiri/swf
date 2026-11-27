import type { Id, SceneCommand, SwfError, Workspace } from '@swf/core';
import { createWorkspace, surfaceEffectiveState } from '@swf/core';
import type {
  BackendChoice,
  Compositor,
  CompositorSession,
  PresentationRegistry,
  PresentedViewport,
  Presenter,
  PresenterEvent,
  ProjectedFragment,
  RendererBackend,
  RendererSession,
  SwitchOutcome,
  ViewProjector,
} from '@swf/presentation';
import { createPresentationRegistry, createPresenter, fragmentId } from '@swf/presentation';
import type { SurfaceRuntime } from '@swf/surfaces';
import { createSurfaceRuntime } from '@swf/surfaces';
import { ManualFrames } from './frames.js';
import type { ConformanceCase } from './harness.js';
import { check, sleep } from './harness.js';
import { MockOpaqueAdapter } from './mock-adapter.js';
import { MockCompositor, MockRenderer } from './mock-backend.js';
import { failWith, releaseAll, runEach, using } from './release.js';

/** What the handoff suite needs: the backend under test, and how it loses its resources. */
export interface HandoffFixture {
  /**
   * A fresh renderer under test, registered beside the reference mocks in each case's own
   * presentation registry.
   */
  renderer(): RendererBackend;
  /** A fresh compositor under test, to pair with the renderer. */
  compositor(): Compositor;
  /** The host container of a viewport. Default: an empty object. */
  container?(viewportId: Id): unknown;
  /**
   * Makes prepared sessions of the backend lose their resources the way they would in use (a
   * lost graphics context). Omit it for a backend that holds nothing it can lose: the loss case
   * is then not applicable.
   */
  loseContext?(sessions: {
    readonly renderer: RendererSession;
    readonly compositor: CompositorSession;
  }): void;
}

const PROJECTION = 'conformance.flat/1';
const REFERENCE: BackendChoice = {
  renderer: 'conformance.reference-renderer/1',
  compositor: 'conformance.reference-compositor/1',
};

/** Live content `a` in the middle, an unbound surface `b` beside it (always a placeholder). */
const flat: ViewProjector = {
  profile: { id: PROJECTION, seamWrapping: false, exactInverse: true },
  project(scene, view) {
    const out: ProjectedFragment[] = [];
    for (const surface of scene.surfaces.values()) {
      const node = scene.nodes.get(surface.ownerNodeId);
      if (node === undefined || surfaceEffectiveState(scene, surface.id)?.visible !== true) {
        continue;
      }
      const left = view.width / 2 + node.transform.position[0] * 100 - 80;
      const top = view.height / 2 - node.transform.position[1] * 100 - 50;
      out.push({
        id: fragmentId(view.viewportId, surface.id, 0),
        surfaceId: surface.id,
        viewportId: view.viewportId,
        ordinal: 0,
        bounds: [left, top, 160, 100],
        card: [left, top, 160, 100],
        scale: 1,
        representation: 'full',
        depth: -node.transform.position[2],
        geometricFidelity: 'exact',
        nativeOwner: true,
      });
    }
    return out;
  },
};

function windowAt(id: string, x: number, bindingKey: string | null): SceneCommand[] {
  return [
    {
      type: 'node.create',
      node: {
        id,
        kind: 'window',
        label: id.toUpperCase(),
        bounds: [1.6, 1, 0.01],
        transform: { position: [x, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    },
    {
      type: 'surface.attach',
      surface: {
        id: `${id}-s`,
        ownerNodeId: id,
        bindingKey,
        adapterTypeId: 'conformance.view/1',
        bounds: [1.6, 1, 0.01],
      },
    },
  ];
}

/** A module whose sessions count their releases, delegating everything else. */
interface Counted {
  readonly released: { renderer: number; compositor: number };
  /** The backend's own sessions, in the order they were prepared. */
  readonly sessions: { renderer: RendererSession; compositor: CompositorSession | null }[];
  /** Each counting wrapper's entry in `sessions`. */
  readonly wrappers: WeakMap<RendererSession, Counted['sessions'][number]>;
}

interface Rig extends Counted {
  readonly ws: Workspace;
  readonly runtime: SurfaceRuntime;
  readonly adapter: MockOpaqueAdapter;
  readonly registry: PresentationRegistry;
  readonly presenter: Presenter;
  readonly events: PresenterEvent[];
  readonly degraded: { container: unknown; error: SwfError; shown: boolean }[];
  readonly container: unknown;
  readonly reference: { renderer: MockRenderer; compositor: MockCompositor };
  readonly underTest: BackendChoice;
  /** Unregisters the renderer under test. */
  readonly removeUnderTest: () => void;
  readonly rendererUnderTest: RendererBackend;
  /** Disposes the presenter, the runtime and the workspace, in that order, each even when one fails. */
  dispose(): Promise<void>;
}

/**
 * The handoff scene with a presenter over it, which the rig's `dispose` disposes with the runtime
 * and workspace. When a step fails, what was made before it is disposed and the failure passed on.
 */
async function rig(fixture: HandoffFixture): Promise<Rig> {
  const ws = createWorkspace({
    id: 'conformance',
    projectionKinds: [{ id: PROJECTION, configIssue: () => null }],
  });
  /** How to dispose of each thing made so far, in the order they were made. */
  const made: (() => unknown)[] = [() => ws.dispose()];
  try {
    const result = ws.transaction([
      { type: 'camera.create', camera: { id: 'cam' } },
      {
        type: 'viewport.create',
        viewport: {
          id: 'v',
          cameraId: 'cam',
          projection: { id: PROJECTION, config: {} },
          size: { width: 800, height: 400, devicePixelRatio: 1 },
        },
      },
      ...windowAt('a', -1, 'key-a'),
      ...windowAt('b', 1.5, null),
    ]);
    check(result.status === 'committed', 'the handoff scene could not be built');
    const runtime = createSurfaceRuntime(ws, { autoBind: false });
    made.push(() => runtime.dispose());
    const adapter = new MockOpaqueAdapter('conformance.view/1');
    runtime.registerAdapter(adapter);
    check((await runtime.bind('a-s')).status === 'ok', 'surface a-s could not be bound');
    const registry = createPresentationRegistry();
    registry.registerProjector(flat);
    const reference = {
      renderer: new MockRenderer(REFERENCE.renderer),
      compositor: new MockCompositor(REFERENCE.compositor),
    };
    registry.registerRenderer(reference.renderer);
    registry.registerCompositor(reference.compositor);
    const counted: Counted = {
      released: { renderer: 0, compositor: 0 },
      sessions: [],
      wrappers: new WeakMap(),
    };
    const renderer = countedRenderer(fixture.renderer(), counted);
    const compositor = countedCompositor(fixture.compositor(), counted);
    const removeUnderTest = registry.registerRenderer(renderer);
    registry.registerCompositor(compositor);
    const events: PresenterEvent[] = [];
    const degraded: Rig['degraded'] = [];
    const presenter = createPresenter({
      workspace: ws,
      runtime,
      registry,
      frames: new ManualFrames(),
      showDegraded: (container, error) => {
        const entry = { container, error, shown: true };
        degraded.push(entry);
        return () => {
          entry.shown = false;
        };
      },
    });
    made.push(() => presenter.dispose());
    presenter.subscribe((event) => events.push(event));
    const container = fixture.container?.('v') ?? {};
    return {
      ...counted,
      ws,
      runtime,
      adapter,
      registry,
      presenter,
      events,
      degraded,
      container,
      reference,
      underTest: { renderer: renderer.id, compositor: compositor.id },
      removeUnderTest,
      rendererUnderTest: renderer,
      dispose: () => releaseAll([...made].reverse()),
    };
  } catch (error) {
    return failWith(error, await runEach([...made].reverse()));
  }
}

function countedRenderer(inner: RendererBackend, counted: Counted): RendererBackend {
  return {
    id: inner.id,
    apiVersion: inner.apiVersion,
    capabilities: () => inner.capabilities(),
    async prepare(scene, view) {
      const session = await inner.prepare(scene, view);
      const entry = { renderer: session, compositor: null as CompositorSession | null };
      counted.sessions.push(entry);
      let released = false;
      const wrapper: RendererSession = {
        rendererId: session.rendererId,
        viewportId: session.viewportId,
        render: (frame) => session.render(frame),
        targetOf: (surfaceId) => session.targetOf(surfaceId),
        watchLoss: (listener) => session.watchLoss(listener),
        async release() {
          if (!released) {
            released = true;
            counted.released.renderer += 1;
          }
          await session.release();
        },
      };
      counted.wrappers.set(wrapper, entry);
      return wrapper;
    },
  };
}

function countedCompositor(inner: Compositor, counted: Counted): Compositor {
  return {
    id: inner.id,
    apiVersion: inner.apiVersion,
    capabilities: () => inner.capabilities(),
    async prepare(target, renderer) {
      // The renderer session handed over is the counting wrapper; the inner compositor gets
      // the backend's own session, as it would without the suite in between.
      const entry = counted.wrappers.get(renderer);
      const session = await inner.prepare(target, entry?.renderer ?? renderer);
      if (entry !== undefined) {
        entry.compositor = session;
      }
      let released = false;
      return {
        compositorId: session.compositorId,
        viewportId: session.viewportId,
        compose: (frame) => session.compose(frame),
        watchLoss: (listener) => session.watchLoss(listener),
        async release() {
          if (!released) {
            released = true;
            counted.released.compositor += 1;
          }
          await session.release();
        },
      };
    },
  };
}

async function open(r: Rig, backends: readonly BackendChoice[]): Promise<PresentedViewport> {
  return r.presenter.open({ viewportId: 'v', container: r.container, backends });
}

async function presented(viewport: PresentedViewport, what: string) {
  const update = await viewport.update();
  check(update.status === 'presented', `${what}: the viewport is degraded`);
  return update;
}

/** Where the adapter last attached surface a-s. */
const attachedTo = (r: Rig) =>
  r.adapter.calls.filter((c) => c.method === 'attach' && c.handle?.key === 'key-a').at(-1)?.target
    ?.container;

const attachments = (r: Rig) =>
  r.runtime.get('a-s')?.viewports.map((v) => `${v.viewportId}:${String(v.visible)}`) ?? [];

/**
 * The runtime cases of renderer and compositor conformance (QA-005): a backend handoff that
 * succeeds, one that fails and rolls back, the loss of a graphics context, and the fallback a
 * running viewport chose, visible, or the viewport visibly degraded when nothing works. Each
 * case runs a presenter over the backend under test with the reference mocks beside it, made when
 * the case runs and disposed when it ends.
 */
export function handoffConformance(fixture: HandoffFixture): ConformanceCase[] {
  const withRig = async (body: (r: Rig) => Promise<void>): Promise<'passed'> => {
    await using(await rig(fixture), (r) => r.dispose(), body);
    return 'passed';
  };
  return [
    {
      name: 'takes a viewport over in a handoff, moving live content in and releasing what it replaced (FR-087)',
      run: () =>
        withRig(async (r) => {
          const v = await open(r, [REFERENCE, r.underTest]);
          await presented(v, 'on the reference backend');
          const before = attachedTo(r);
          const outcome = await v.switchBackend(r.underTest);
          check(
            outcome.status === 'switched',
            `the switch to the backend under test did not happen: ${JSON.stringify(outcome)}`,
          );
          check(
            r.reference.renderer.sessions.every((s) => s.released === 1),
            'the replaced reference renderer session was not released',
          );
          const frame = await presented(v, 'after the switch');
          check(
            frame.metrics.rendererId === r.underTest.renderer,
            'the frame after the switch was not rendered by the backend under test',
          );
          const live = frame.rendered.layers.some(
            (l) => l.surfaceId === 'a-s' && l.category === 'content-native',
          );
          if (live) {
            const session = r.sessions.at(-1)?.renderer;
            check(
              attachedTo(r) === session?.targetOf('a-s') && attachedTo(r) !== before,
              'the live content was not moved into the new backend’s target',
            );
          }
          check(
            attachments(r).length === (live ? 1 : 0),
            `surface a-s is attached ${JSON.stringify(attachments(r))} after the switch`,
          );
          // And back: the backend under test is released in turn.
          const back = await v.switchBackend(REFERENCE);
          check(back.status === 'switched', 'the switch back to the reference backend failed');
          check(
            r.released.renderer === 1 && r.released.compositor === 1,
            'the backend under test was not released exactly once when replaced',
          );
          await presented(v, 'back on the reference backend');
          check(
            attachments(r).join() === 'v:true',
            'the live content did not come back to the reference backend',
          );
        }),
    },
    {
      name: 'keeps presenting when a switch away from it fails, with the live content where it was (FR-087, §13.5)',
      run: () =>
        withRig(async (r) => {
          const v = await open(r, [r.underTest]);
          const first = await presented(v, 'on the backend under test');
          const where = attachedTo(r);
          // Preparing fails.
          r.reference.renderer.failPrepare = 'no resources';
          const failures: [string, SwitchOutcome][] = [
            ['preparing', await v.switchBackend(REFERENCE)],
          ];
          r.reference.renderer.failPrepare = null;
          // Moving the live content fails half way (when the backend shows it live at all).
          if (
            first.rendered.layers.some(
              (l) => l.surfaceId === 'a-s' && l.category === 'content-native',
            )
          ) {
            const attach = r.adapter.attach.bind(r.adapter);
            r.adapter.attach = (handle, target) =>
              target.container === where ? attach(handle, target) : Promise.reject(new Error('no'));
            failures.push(['moving content', await v.switchBackend(REFERENCE)]);
            r.adapter.attach = attach;
          }
          for (const [what, outcome] of failures) {
            check(
              outcome.status === 'kept' && outcome.backend.renderer === r.underTest.renderer,
              `a switch that failed ${what} did not keep the backend under test: ${JSON.stringify(outcome)}`,
            );
          }
          check(
            r.released.renderer === 0 && r.released.compositor === 0,
            'the backend under test was released by a switch that failed',
          );
          check(
            attachedTo(r) === where,
            'the live content was not put back where it was after the failed switch',
          );
          check(
            r.reference.renderer.sessions.every((s) => s.released === 1),
            'a session prepared for the failed switch was not released',
          );
          const frame = await presented(v, 'after the failed switches');
          check(
            frame.metrics.rendererId === r.underTest.renderer,
            'the backend under test stopped presenting after the failed switches',
          );
        }),
    },
    {
      name: 'gives way to a fallback when it loses its graphics context, and comes back when restored (§27)',
      run: async () => {
        const lose = fixture.loseContext?.bind(fixture);
        if (lose === undefined) {
          return 'not-applicable';
        }
        return withRig(async (r) => {
          const v = await open(r, [r.underTest, REFERENCE]);
          await presented(v, 'on the backend under test');
          const renderer = r.sessions.at(-1)?.renderer;
          const compositor = r.sessions.at(-1)?.compositor ?? null;
          check(
            renderer !== undefined && compositor !== null,
            'the backend under test has no prepared sessions',
          );
          lose({ renderer, compositor });
          // Loss is reported asynchronously by browsers; give it a moment.
          for (let i = 0; i < 50 && v.backend?.renderer !== REFERENCE.renderer; i++) {
            await sleep(2);
          }
          check(
            r.events.some((e) => e.type === 'backend.lost'),
            'losing the context was not reported as a lost backend',
          );
          check(
            v.backend?.renderer === REFERENCE.renderer,
            'the viewport did not fall back after the backend under test lost its context',
          );
          check(r.released.renderer === 1, 'the backend that lost its context was not released');
          await presented(v, 'on the fallback');
          const restored = await v.restore();
          check(
            restored.status === 'switched' && restored.backend.renderer === r.underTest.renderer,
            `restoring did not bring the backend under test back: ${JSON.stringify(restored)}`,
          );
          await presented(v, 'restored');
        });
      },
    },
    {
      name: 'shows the fallback it chose in a running viewport, and degrades visibly when nothing works (FR-083, AC-005, §33.2 scenario 6)',
      run: () =>
        withRig(async (r) => {
          const v = await open(r, [r.underTest]);
          // Read afresh each time: the state changes behind the checks.
          const state = () => v.state;
          const frame = await presented(v, 'on the backend under test');
          // The unbound surface is a placeholder, declared as a fallback and composed.
          const placeholder = frame.rendered.layers.find((l) => l.surfaceId === 'b-s');
          check(
            placeholder?.category === 'placeholder',
            `the unbound surface was realized as ${String(placeholder?.category)}, not a placeholder`,
          );
          check(
            frame.composed.order.includes(placeholder.id),
            'the placeholder was not composed into the viewport',
          );
          check(
            frame.frame.fallbacks.some((f) => f.surfaceId === 'b-s' && f.chosen === 'placeholder'),
            'the placeholder was not reported as a fallback',
          );
          check(
            frame.frame.planned.every(
              (p) => p.negotiation.contentFidelity !== 'exact' || p.negotiation.fallback === null,
            ),
            'a fallback was labelled exact',
          );
          // The renderer goes away with nothing to fall back to: the viewport says so.
          r.removeUnderTest();
          for (let i = 0; i < 50 && state() !== 'presentation-degraded'; i++) {
            await sleep(1);
          }
          check(state() === 'presentation-degraded', 'the viewport did not degrade');
          check(
            r.degraded.length === 1 && r.degraded[0]?.container === r.container,
            'the degraded viewport was not shown in its container',
          );
          check(
            (await v.update()).status === 'degraded',
            'a degraded viewport still claimed to present frames',
          );
          // The scene stays usable, and when the renderer returns the viewport resumes.
          const moved = r.ws.dispatch({
            type: 'node.patch',
            id: 'a',
            transform: { position: [-1.5, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          });
          check(moved.status === 'committed', 'the scene stopped taking commands while degraded');
          r.registry.registerRenderer(r.rendererUnderTest);
          for (let i = 0; i < 50 && state() !== 'active'; i++) {
            await sleep(1);
          }
          check(state() === 'active', 'the viewport did not resume when its renderer came back');
          check(r.degraded[0]?.shown === false, 'the degraded notice stayed after resuming');
          const resumed = await presented(v, 'after resuming');
          const a = resumed.frame.output.fragmentsOf('a-s')[0];
          check(
            a?.bounds[0] === 800 / 2 - 150 - 80,
            'the layout changed while degraded was not what the resumed viewport showed',
          );
        }),
    },
  ];
}
