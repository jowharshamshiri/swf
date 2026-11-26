import { animationFrames, createDomInput, DOM_COMPOSITOR_ID, DOM_RENDERER_ID, DomCompositor, DomRenderer, showDegraded, } from '@swf/backend-dom';
import { createWorkspace } from '@swf/core';
import { createInteractionRouter } from '@swf/interaction';
import { createPresentationRegistry, createPresenter } from '@swf/presentation';
import { createProjectionRegistry, equirectangular } from '@swf/projections';
import { ADAPTER_API_VERSION, createSurfaceRuntime } from '@swf/surfaces';
import { DRAWN_ADAPTER, LIVE_ADAPTER } from './fixture.js';
/** CSS pixels a live element lays out per world unit. */
const PIXELS_PER_UNIT = 160;
const LIVE_CAPABILITIES = Object.freeze({
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
const DRAWN_CAPABILITIES = Object.freeze({
    ...LIVE_CAPABILITIES,
    attachStrategy: 'drawable',
    nativeInteraction: 'none',
    transformFidelity: 'exact',
});
/** The fixture's content: elements that cost no more than being laid out, and proxies. */
function adapters(document) {
    const resolve = (make) => (key, signal) => signal.aborted ? Promise.reject(signal.reason) : Promise.resolve(make(key));
    const live = Object.freeze({
        id: LIVE_ADAPTER,
        apiVersion: ADAPTER_API_VERSION,
        declaredCapabilities: LIVE_CAPABILITIES,
        resolve: resolve((key) => ({ key, elements: new Map() })),
        capabilities: () => LIVE_CAPABILITIES,
        attach(handle, target) {
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
        detach(handle, target) {
            handle.elements.get(target.viewportId)?.remove();
            handle.elements.delete(target.viewportId);
        },
    });
    const drawn = Object.freeze({
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
/**
 * Lays out an element for each of a fixture's viewports in `parent`, where the fixture places it
 * on the page, and returns them in the fixture's order. The elements are absolutely positioned,
 * in CSS pixels, and are the caller's to remove.
 */
export function layoutViewports(parent, fixture) {
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
        ]) {
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
export async function createBenchmarkHost(options) {
    const { fixture, containers } = options;
    if (containers.length !== fixture.viewports.length) {
        throw new Error(`containers: the fixture has ${String(fixture.viewports.length)} viewports, given ${String(containers.length)} elements`);
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
    const made = [() => workspace.dispose()];
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
        registry.registerRenderer(new DomRenderer({ document, pixelsPerUnit: PIXELS_PER_UNIT, chrome: { projections } }));
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
        const viewports = [];
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
        const observers = new Set();
        const device = createDomInput({
            root: main.container,
            viewportId: main.fixture.id,
            events: (listener) => router.subscribe(listener),
        });
        // The device, with every dispatch it makes told to those observing input.
        const observed = {
            id: device.id,
            apiVersion: device.apiVersion,
            connect: (dispatch) => device.connect((intent) => {
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
        const unbound = () => runtime.list().some((s) => s.state === 'binding' || s.state === 'unbound');
        let disposed = null;
        return Object.freeze({
            fixture,
            workspace,
            runtime,
            projections,
            presenter,
            router,
            viewports: Object.freeze(viewports),
            observeInput(listener) {
                observers.add(listener);
                return () => {
                    observers.delete(listener);
                };
            },
            async settled() {
                if (unbound()) {
                    await new Promise((resolve) => {
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
    }
    catch (error) {
        return failWith(error, await disposeMade());
    }
}
/**
 * Runs each disposal in turn, every one even when one before it fails, and resolves to what
 * failed, in order.
 */
async function disposeEach(disposals) {
    const failed = [];
    for (const dispose of disposals) {
        try {
            await dispose();
        }
        catch (error) {
            failed.push({ error });
        }
    }
    return failed;
}
/**
 * Throws `error` as it is when nothing else `failed`; otherwise an `AggregateError` holding
 * `error`, then each other failure, in order.
 */
function failWith(error, failed) {
    if (failed.length === 0) {
        throw error;
    }
    const all = [error, ...failed.map((f) => f.error)];
    throw new AggregateError(all, all.map(describe).join('; and then '));
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=host.js.map