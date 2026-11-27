import {
  animationFrames,
  createDomInput,
  DOM_COMPOSITOR_ID,
  DOM_RENDERER_ID,
  DomCompositor,
  DomRenderer,
  showDegraded,
} from '@swf/backend-dom';
import type { Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import type {
  DispatchResult,
  InputAdapter,
  InputIntent,
  InteractionRouter,
} from '@swf/interaction';
import { createInteractionRouter } from '@swf/interaction';
import type { PresentedViewport, Presenter } from '@swf/presentation';
import { createPresentationRegistry, createPresenter } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import { createProjectionRegistry, equirectangular } from '@swf/projections';
import type { SurfaceAdapter, SurfaceCapabilities, SurfaceRuntime } from '@swf/surfaces';
import { ADAPTER_API_VERSION, createSurfaceRuntime } from '@swf/surfaces';
import type { Fixture, FixtureViewport } from './fixture.js';
import { DRAWN_ADAPTER, LIVE_ADAPTER } from './fixture.js';

const LIVE_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  attachStrategy: 'native-dom',
  nativeInteraction: 'full',
  uvAddressing: true,
  transformFidelity: 'approximate',
  transparency: false,
  clipping: true,
  cursorMapping: true,
  resize: 'intrinsic',
  viewportSharing: 'shared',
  safeDetach: true,
  rebinding: true,
  placeholder: false,
  snapshotHooks: false,
});

const DRAWN_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  ...LIVE_CAPABILITIES,
  attachStrategy: 'drawable',
  nativeInteraction: 'none',
  transformFidelity: 'exact',
});

/** A live endpoint: a plain element per viewport, with its key as its only text. */
interface LiveHandle {
  readonly key: string;
  readonly elements: Map<string, HTMLElement>;
}

/** A drawn endpoint: nothing is mounted; the DOM backend shows it as a proxy. */
interface DrawnHandle {
  readonly key: string;
}

/** The fixture's content: elements that cost no more than being laid out, and proxies. */
function adapters(document: Document): {
  readonly live: SurfaceAdapter<LiveHandle>;
  readonly drawn: SurfaceAdapter<DrawnHandle>;
} {
  const resolve =
    <T>(make: (key: string) => T) =>
    (key: string, signal: AbortSignal): Promise<T> =>
      signal.aborted ? Promise.reject(signal.reason as Error) : Promise.resolve(make(key));
  const live: SurfaceAdapter<LiveHandle> = Object.freeze({
    id: LIVE_ADAPTER,
    apiVersion: ADAPTER_API_VERSION,
    declaredCapabilities: LIVE_CAPABILITIES,
    resolve: resolve((key) => ({ key, elements: new Map<string, HTMLElement>() })),
    capabilities: () => LIVE_CAPABILITIES,
    attach(handle: LiveHandle, target: { viewportId: string; container: unknown }) {
      if (!(target.container instanceof HTMLElement)) {
        throw new Error('a live endpoint can only be attached to an element');
      }
      let element = handle.elements.get(target.viewportId);
      if (element === undefined) {
        element = document.createElement('div');
        element.textContent = handle.key;
        element.style.setProperty('width', '100%');
        element.style.setProperty('height', '100%');
        element.style.setProperty('background', '#dde4ee');
        element.style.setProperty('font', '14px sans-serif');
        handle.elements.set(target.viewportId, element);
      }
      target.container.append(element);
    },
    update: () => undefined,
    detach(handle: LiveHandle, target: { viewportId: string }) {
      handle.elements.get(target.viewportId)?.remove();
      handle.elements.delete(target.viewportId);
    },
  });
  const drawn: SurfaceAdapter<DrawnHandle> = Object.freeze({
    id: DRAWN_ADAPTER,
    apiVersion: ADAPTER_API_VERSION,
    declaredCapabilities: DRAWN_CAPABILITIES,
    resolve: resolve((key) => ({ key })),
    capabilities: () => DRAWN_CAPABILITIES,
    attach: () => undefined,
    update: () => undefined,
    detach: () => undefined,
  });
  return { live, drawn };
}

/** One of the fixture's viewports, presented in its own element. */
export interface HostViewport {
  /** The fixture's viewport it presents. */
  readonly fixture: FixtureViewport;
  /** The caller's element it is presented in. */
  readonly container: HTMLElement;
  /** The presenter's viewport, owned by the host's presenter. */
  readonly viewport: PresentedViewport;
}

/**
 * The framework presenting a fixture, as a host composes it. It owns the workspace, runtime,
 * presenter and router it made, and releases them in {@link BenchmarkHost.dispose}; the
 * containers stay the caller's. Frozen.
 */
export interface BenchmarkHost {
  /** The fixture presented. */
  readonly fixture: Fixture;
  /**
   * The workspace holding the fixture's scene, its announcements paced by the window's animation
   * frames and its operations timed by `performance.now`.
   */
  readonly workspace: Workspace;
  /** The surface runtime binding the fixture's live and drawn content. */
  readonly runtime: SurfaceRuntime;
  /** The projection registry, with the equirectangular projection registered. */
  readonly projections: ProjectionRegistry;
  /** The presenter of the viewports, on the DOM renderer and compositor. */
  readonly presenter: Presenter;
  /** Routes input taken over the first viewport. */
  readonly router: InteractionRouter;
  /** The fixture's viewports, in the fixture's order. */
  readonly viewports: readonly HostViewport[];
  /**
   * Calls `listener` with every input intent dispatched and its result, synchronously as the
   * router returns; returns what stops it. A listener that throws is not isolated: the throw
   * reaches the input device.
   */
  observeInput(listener: (intent: InputIntent, result: DispatchResult) => void): () => void;
  /**
   * Resolves once every surface has bound and every viewport has presented a frame. Rejects with
   * `Error` when a viewport is degraded.
   */
  settled(): Promise<void>;
  /**
   * Stops observing input and disposes the router, presenter, runtime and workspace, in that
   * order, each even when one before it fails. The containers stay in place, holding nothing of
   * the framework's. The same promise on every call.
   *
   * @throws As a disposal fails (as a rejection); an `AggregateError` holding each failure, in
   *   order, when more than one does.
   */
  dispose(): Promise<void>;
}

/** What a benchmark host presents, and where. */
export interface BenchmarkHostOptions {
  /** The fixture to make and present, as {@link planFixture} gives it. */
  readonly fixture: Fixture;
  /**
   * The elements the fixture's viewports are presented in, one for each, in the fixture's order:
   * the caller's, as a host's own page is ({@link layoutViewports} makes them). Disposing the host
   * leaves them in place, holding nothing of the framework's.
   */
  readonly containers: readonly HTMLElement[];
}

/**
 * Lays out an element for each of a fixture's viewports in `parent`, where the fixture places it
 * on the page, and returns them in the fixture's order. The elements are absolutely positioned,
 * in CSS pixels, and are the caller's to remove.
 */
export function layoutViewports(parent: HTMLElement, fixture: Fixture): HTMLElement[] {
  return fixture.viewports.map((v) => {
    const container = parent.ownerDocument.createElement('div');
    container.dataset['swfBenchViewport'] = v.id;
    for (const [property, value] of [
      ['position', 'absolute'],
      ['left', `${String(v.left)}px`],
      ['top', `${String(v.top)}px`],
      ['width', `${String(v.width)}px`],
      ['height', `${String(v.height)}px`],
      ['overflow', 'hidden'],
    ] as const) {
      container.style.setProperty(property, value);
    }
    parent.append(container);
    return container;
  });
}

/**
 * Presents a fixture with the framework's DOM backend, on the parent's window's animation frames:
 * a workspace with the equirectangular projection, the fixture's scene committed as one
 * transaction, its content bound through two adapters, each viewport presented in its own element,
 * and input over the first taken by the interaction router with its built-in policies. The caller
 * owns the host and disposes it.
 *
 * When a step fails, everything made before it is disposed, in reverse order, and the failure
 * passed on: the containers are left holding nothing of the framework's.
 *
 * @throws `Error` (as a rejection) when the containers are not one per viewport or not in a
 *   window, or the fixture's scene cannot be committed. A viewport that cannot open rejects as
 *   the presenter does. When disposing what was made also fails, it rejects with an
 *   `AggregateError` holding the step's failure, then each disposal's.
 *
 * @example
 * ```ts
 * const fixture = planFixture(STANDARD, 1);
 * const host = await createBenchmarkHost({
 *   fixture,
 *   containers: layoutViewports(document.body, fixture),
 * });
 * await host.settled();
 * const frames = recordFrames(window);
 * // ... run the scenario ...
 * const analysis = analyseFrames(frames.stop());
 * await host.dispose();
 * ```
 */
export async function createBenchmarkHost(options: BenchmarkHostOptions): Promise<BenchmarkHost> {
  const { fixture, containers } = options;
  if (containers.length !== fixture.viewports.length) {
    throw new Error(
      `containers: the fixture has ${String(fixture.viewports.length)} viewports, given ${String(containers.length)} elements`,
    );
  }
  const document = containers[0]?.ownerDocument;
  const view = document?.defaultView ?? null;
  if (document === undefined || view === null) {
    throw new Error('containers: the elements are not in a window');
  }
  const timer = () => view.performance.now();
  // One frame source paces the workspace's announcements and the presenter's frames.
  const frames = animationFrames(view);
  const workspace = createWorkspace({
    id: 'benchmark',
    frameBoundary: (flush) => {
      frames.request(flush);
    },
    timer,
  });
  /** How to dispose of each thing made so far, in the order they were made. */
  const made: (() => unknown)[] = [() => workspace.dispose()];
  /** Disposes of everything made, the last made first. */
  const disposeMade = () => disposeEach([...made].reverse());
  try {
    const registry = createPresentationRegistry();
    const projections = createProjectionRegistry({
      kinds: workspace.mutator(),
      projectors: registry.registrar(),
    });
    projections.register(equirectangular);
    const scene = workspace.transaction(fixture.commands, { source: 'system' });
    if (scene.status !== 'committed') {
      throw new Error(`the fixture could not be made: ${JSON.stringify(scene)}`);
    }
    const runtime = createSurfaceRuntime(workspace);
    made.push(() => runtime.dispose());
    const content = adapters(document);
    runtime.registerAdapter(content.live);
    runtime.registerAdapter(content.drawn);
    registry.registerRenderer(new DomRenderer({ document, chrome: {} }));
    registry.registerCompositor(new DomCompositor());
    const presenter = createPresenter({
      workspace,
      runtime,
      registry,
      frames,
      showDegraded,
      now: timer,
    });
    // Disposing the presenter disposes every viewport it opened.
    made.push(() => presenter.dispose());
    const viewports: HostViewport[] = [];
    for (const [i, v] of fixture.viewports.entries()) {
      const container = containers[i];
      if (container === undefined) {
        throw new Error(`containers: no element for viewport "${v.id}"`);
      }
      const viewport = await presenter.open({
        viewportId: v.id,
        container,
        backends: [{ renderer: DOM_RENDERER_ID, compositor: DOM_COMPOSITOR_ID }],
      });
      viewports.push({ fixture: v, container, viewport });
    }
    const main = viewports[0];
    if (main === undefined) {
      throw new Error('the fixture has no viewport');
    }
    const router = createInteractionRouter({
      workspace,
      projections,
      presentation: (surfaceId) => main.viewport.presentation(surfaceId),
      timer,
    });
    made.push(() => {
      router.dispose();
    });
    const observers = new Set<(intent: InputIntent, result: DispatchResult) => void>();
    const device = createDomInput({
      root: main.container,
      viewportId: main.fixture.id,
      events: (listener) => router.subscribe(listener),
    });
    // The device, with every dispatch it makes told to those observing input.
    const observed: InputAdapter = {
      id: device.id,
      apiVersion: device.apiVersion,
      connect: (dispatch) =>
        device.connect((intent) => {
          const result = dispatch(intent);
          for (const listener of observers) {
            listener(intent, result);
          }
          return result;
        }),
    };
    made.push(router.registerInputAdapter(observed), () => {
      observers.clear();
    });
    const unbound = () =>
      runtime.list().some((s) => s.state === 'binding' || s.state === 'unbound');
    let disposed: Promise<void> | null = null;
    return Object.freeze({
      fixture,
      workspace,
      runtime,
      projections,
      presenter,
      router,
      viewports: Object.freeze(viewports),
      observeInput(listener: (intent: InputIntent, result: DispatchResult) => void) {
        observers.add(listener);
        return () => {
          observers.delete(listener);
        };
      },
      async settled() {
        if (unbound()) {
          await new Promise<void>((resolve) => {
            const stop = runtime.subscribe(() => {
              if (!unbound()) {
                stop();
                resolve();
              }
            });
          });
        }
        for (const v of viewports) {
          const frame = await v.viewport.update();
          if (frame.status !== 'presented') {
            throw new Error(`viewport "${v.fixture.id}" is degraded: ${frame.error.message}`);
          }
        }
      },
      dispose() {
        disposed ??= (async () => {
          const [first, ...more] = await disposeMade();
          if (first !== undefined) {
            failWith(first.error, more);
          }
        })();
        return disposed;
      },
    });
  } catch (error) {
    return failWith(error, await disposeMade());
  }
}

/**
 * Runs each disposal in turn, every one even when one before it fails, and resolves to what
 * failed, in order.
 */
async function disposeEach(
  disposals: readonly (() => unknown)[],
): Promise<{ readonly error: unknown }[]> {
  const failed: { readonly error: unknown }[] = [];
  for (const dispose of disposals) {
    try {
      await dispose();
    } catch (error) {
      failed.push({ error });
    }
  }
  return failed;
}

/**
 * Throws `error` as it is when nothing else `failed`; otherwise an `AggregateError` holding
 * `error`, then each other failure, in order.
 */
function failWith(error: unknown, failed: readonly { readonly error: unknown }[]): never {
  if (failed.length === 0) {
    throw error;
  }
  const all = [error, ...failed.map((f) => f.error)];
  throw new AggregateError(all, all.map(describe).join('; and then '));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
