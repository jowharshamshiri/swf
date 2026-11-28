import { DOM_COMPOSITOR_ID, DOM_RENDERER_ID } from '@swf/backend-dom';
import { LAYER_COMPOSITOR_ID } from '@swf/backend-geometry';
import type { Id, SceneCommand } from '@swf/core';
import type { Diagnostics, Disclosure, OperationTrace } from '@swf/diagnostics';
import { createDiagnostics, createOperationTrace, exportDiagnostics } from '@swf/diagnostics';
import type { PresentedViewport } from '@swf/presentation';
import type { SurfaceAdapter, SurfaceCapabilities } from '@swf/surfaces';
import { ADAPTER_API_VERSION } from '@swf/surfaces';
import { resolvePalette } from '@wsb/uikit/primitives';
import type { ReferenceApp } from './app.js';
import { WORKSPACE_GROUP_ID } from './presets.js';
import {
  CAMERA_ID,
  LAYERED_RENDERER_ID,
  PANORAMA,
  VIEWPORT_ID,
  layoutSurfaces,
} from '@swf/navigation';

/**
 * The developer tools of staging builds and development (§22, DLV-010): a session-only record
 * of what the running application does, read through the framework's public reading APIs only,
 * never by changing the scene behind its back or by looking into a surface's content (ADM-001,
 * ADM-004): the event timeline; input, picking and navigation measures (AN-004, AN-006); the
 * diagnostics report and the operation trace with their exports (AN-011, AUD-002, PRIV-003);
 * and failure simulation (ADM-003, FR-195, §33.2 scenario 7): windows whose adapter is missing,
 * slow or throwing, a second view of the scene that a single-owner surface cannot be shown in,
 * and backends whose renderer is taken away. Production builds carry none of it.
 */

/** One thing that happened, by the IDs it concerns: never a label, a key or content. */
export interface TimelineEntry {
  readonly seq: number;
  /** Milliseconds since the tools started, by the page's monotonic clock. */
  readonly at: number;
  readonly origin: 'scene' | 'surfaces' | 'input' | 'presentation';
  readonly type: string;
  readonly detail: string;
}

/** Where the last input that picked landed. */
export interface LastTarget {
  readonly viewportId: Id;
  readonly x: number;
  readonly y: number;
  readonly nodeId: Id | null;
  readonly surfaceId: Id | null;
  readonly region: string | null;
  readonly route: string;
  readonly ambiguous: boolean;
}

/** Input and picking measures (AN-004). */
export interface InputMeasures {
  readonly dispatches: number;
  readonly byAdapter: Readonly<Record<string, number>>;
  readonly picks: number;
  readonly ambiguous: number;
  readonly lastPickMs: number | null;
  readonly maxPickMs: number | null;
  readonly totalPickMs: number;
  /** Gestures cancelled, by reason. */
  readonly cancels: Readonly<Record<string, number>>;
  readonly lastTarget: LastTarget | null;
}

/** Mode navigation measures (AN-006). */
export interface NavigationMeasures {
  /** Mode changes, by `<from>→<to>`. */
  readonly transitions: Readonly<Record<string, number>>;
  /** From a change of view mode to the next focus change, in milliseconds. */
  readonly focusTimes: {
    readonly count: number;
    readonly last: number | null;
    readonly total: number;
  };
  /** How far pointers travelled in the view's virtual pointer space, in CSS pixels. */
  readonly travelPx: number;
}

/** A failure the tools can simulate. */
export type SimulatedFailure = 'missing' | 'slow' | 'throwing';

export const SIMULATED_FAILURES: readonly SimulatedFailure[] = Object.freeze([
  'missing',
  'slow',
  'throwing',
]);

/** The adapter type each simulated window's surface is bound through. */
export const SIMULATED_ADAPTERS: Readonly<Record<SimulatedFailure, string>> = Object.freeze({
  missing: 'reference.simulated.missing/1',
  slow: 'reference.simulated.slow/1',
  throwing: 'reference.simulated.throwing/1',
});

/** The viewport the second view presents. */
export const SECOND_VIEWPORT_ID = 'second';

export interface DevtoolsOptions {
  /** How long the slow adapter takes to resolve, in milliseconds. */
  readonly slowMs?: number;
  /** How many timeline entries are kept. */
  readonly timelineCapacity?: number;
}

export interface Devtools {
  readonly diagnostics: Diagnostics;
  readonly trace: OperationTrace;
  timeline(): readonly TimelineEntry[];
  input(): InputMeasures;
  navigation(): NavigationMeasures;
  /** Calls `listener` whenever something the tools show changed; returns what stops it. */
  subscribe(listener: () => void): () => void;
  /** Adds a window whose surface fails as named; returns its ID. */
  simulate(failure: SimulatedFailure): Id;
  /** The simulated windows in the scene, by failure. */
  simulated(): Readonly<Partial<Record<SimulatedFailure, Id>>>;
  /**
   * Recovers a simulated failure as its host would: the missing adapter registered, the slow
   * one let finish now, the throwing one fixed and its surface bound again.
   */
  recover(failure: SimulatedFailure): Promise<void>;
  /** Removes the simulated windows from the workspace. */
  clearSimulated(): void;
  /** Presents the scene in a second view in `container` (geometry backend first). */
  openSecondView(container: HTMLElement): Promise<PresentedViewport>;
  closeSecondView(): Promise<void>;
  secondView(): PresentedViewport | null;
  /**
   * Draws over the panorama, taking no input (ADM-002): each fragment's bounds and the
   * surface's projected outline, a seam's second fragment marked as standing for the same
   * surface, and where the last pick landed with what it hit.
   */
  showOverlay(on: boolean): void;
  overlayShown(): boolean;
  /** The diagnostics export as JSON text, disclosing only what is asked. */
  exportDiagnostics(disclosure: Partial<Disclosure>): string;
  dispose(): Promise<void>;
}

/** Capabilities of the simulated adapters' endpoints: native elements, one view at a time. */
const SIMULATED_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  attachStrategy: 'native-dom',
  nativeInteraction: 'full',
  uvAddressing: true,
  transformFidelity: 'approximate',
  transparency: false,
  clipping: true,
  cursorMapping: true,
  resize: 'intrinsic',
  viewportSharing: 'single-owner',
  safeDetach: true,
  rebinding: true,
  placeholder: false,
  snapshotHooks: false,
  takeover: true,
});

/** Where each simulated window stands: low ahead and to either side. */
const PLACES: Readonly<Record<SimulatedFailure, number>> = Object.freeze({
  missing: -40,
  slow: 0,
  throwing: 40,
});

export function createDevtools(app: ReferenceApp, options: DevtoolsOptions = {}): Devtools {
  const { workspace, runtime } = app;
  const document = app.root.ownerDocument;
  const view = document.defaultView;
  if (view === null) {
    throw new Error('the application is not in a window');
  }
  const clock = () => view.performance.now();
  const started = clock();
  const capacity = options.timelineCapacity ?? 300;
  const slowMs = options.slowMs ?? 4000;
  const diagnostics = createDiagnostics({
    workspace,
    runtime,
    presenter: app.presenter,
    registry: app.presentation,
  });
  const trace = createOperationTrace({ workspace });
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  // The timeline.
  const entries: TimelineEntry[] = [];
  let seq = 0;
  const record = (origin: TimelineEntry['origin'], type: string, detail: string) => {
    seq += 1;
    entries.push(Object.freeze({ seq, at: clock() - started, origin, type, detail }));
    if (entries.length > capacity) {
      entries.shift();
    }
  };

  // Input and navigation.
  const input = {
    dispatches: 0,
    byAdapter: {} as Record<string, number>,
    picks: 0,
    ambiguous: 0,
    lastPickMs: null as number | null,
    maxPickMs: null as number | null,
    totalPickMs: 0,
    cancels: {} as Record<string, number>,
    lastTarget: null as LastTarget | null,
  };
  const navigation = {
    transitions: {} as Record<string, number>,
    focusTimes: { count: 0, last: null as number | null, total: 0 },
    travelPx: 0,
  };
  const pointers = new Map<string, { x: number; y: number }>();
  let mode = app.modes.current();
  let navigatingSince: number | null = null;

  const stops: (() => void)[] = [
    workspace.subscribe((event) => {
      switch (event.type) {
        case 'transform.preview':
          return;
        case 'transaction.committed':
          record(
            'scene',
            event.type,
            `${event.payload.commandTypes.join(', ')} → revision ${String(event.revision)}`,
          );
          break;
        case 'transaction.rejected':
          record(
            'scene',
            event.type,
            `${event.payload.commandTypes.join(', ')}: ${event.payload.error.code}`,
          );
          break;
        case 'viewport.updated': {
          const now = app.modes.current();
          if (event.payload.viewportId === VIEWPORT_ID && now !== mode) {
            const key = `${mode}→${now}`;
            navigation.transitions[key] = (navigation.transitions[key] ?? 0) + 1;
            mode = now;
            navigatingSince = clock();
          }
          record(
            'scene',
            event.type,
            `${event.payload.viewportId}: ${event.payload.fields.join(', ')}`,
          );
          break;
        }
        case 'focus.changed':
          if (navigatingSince !== null && event.payload.focusedId !== null) {
            const took = clock() - navigatingSince;
            navigation.focusTimes = {
              count: navigation.focusTimes.count + 1,
              last: took,
              total: navigation.focusTimes.total + took,
            };
            navigatingSince = null;
          }
          record('scene', event.type, String(event.payload.focusedId));
          break;
        default:
          record('scene', event.type, idsOf(event.payload));
      }
      tell();
    }),
    runtime.subscribe((event) => {
      if (event.type === 'presentation.stateChanged') {
        const p = event.payload;
        record(
          'surfaces',
          event.type,
          `${p.surfaceId}: ${String(p.from)} → ${p.to}${p.error === null ? '' : ` (${p.error.code})`}${p.unboundReason === null ? '' : ` (${p.unboundReason})`}`,
        );
      } else if (event.type === 'presentation.viewportChanged') {
        const p = event.payload;
        record(
          'surfaces',
          event.type,
          `${p.surfaceId} in ${p.viewportId}: ${p.attached ? (p.visible ? 'shown' : 'hidden') : 'released'}`,
        );
      } else {
        record('surfaces', event.type, idsOf(event.payload));
      }
      tell();
    }),
    app.router.subscribe((event) => {
      if (event.type === 'gesture.started') {
        record(
          'input',
          event.type,
          `${event.operation} on ${String(event.nodeId)} (${event.gestureId})`,
        );
      } else if (event.type === 'gesture.ended') {
        const finish = event.finish;
        if (finish.outcome === 'cancelled') {
          input.cancels[finish.reason] = (input.cancels[finish.reason] ?? 0) + 1;
        }
        record(
          'input',
          event.type,
          `${event.gestureId}: ${finish.outcome}${finish.outcome === 'cancelled' ? ` (${finish.reason})` : ''}`,
        );
      }
      tell();
    }),
    app.presenter.subscribe((event) => {
      if (event.type !== 'frame') {
        record(
          'presentation',
          event.type,
          `${event.viewportId}${'error' in event ? `: ${event.error.code}` : ''}`,
        );
      }
      tell();
    }),
    app.observeInput(({ adapterId, intent, result }) => {
      input.dispatches += 1;
      input.byAdapter[adapterId] = (input.byAdapter[adapterId] ?? 0) + 1;
      if (result.pick !== null) {
        input.picks += 1;
        input.ambiguous += result.pick.ambiguous ? 1 : 0;
        input.lastPickMs = result.pick.ms;
        input.maxPickMs = Math.max(input.maxPickMs ?? 0, result.pick.ms);
        input.totalPickMs += result.pick.ms;
      }
      if (intent.kind === 'pointer' || intent.kind === 'wheel') {
        if (result.pick !== null) {
          input.lastTarget = Object.freeze({
            viewportId: intent.viewportId,
            x: intent.x,
            y: intent.y,
            nodeId: result.target?.nodeId ?? null,
            surfaceId: result.target?.surfaceId ?? null,
            region: result.region,
            route: result.route,
            ambiguous: result.pick.ambiguous,
          });
        }
        if (intent.kind === 'pointer') {
          const key = `${intent.deviceId}/${String(intent.pointerId)}`;
          const last = pointers.get(key);
          if (last !== undefined && intent.phase === 'move') {
            navigation.travelPx += Math.hypot(intent.x - last.x, intent.y - last.y);
          }
          if (intent.phase === 'up' || intent.phase === 'cancel') {
            pointers.delete(key);
          } else {
            pointers.set(key, { x: intent.x, y: intent.y });
          }
        }
      }
      tell();
    }),
  ];

  // Failure simulation.
  let attachFails = true;
  const slowReleases = new Set<() => void>();
  const unregisters = new Map<string, () => void>();
  const simulatedContent = (key: string): HTMLElement => {
    const element = document.createElement('article');
    element.dataset['referenceContent'] = key;
    element.textContent = `Simulated content: ${key}`;
    element.style.setProperty('box-sizing', 'border-box');
    element.style.setProperty('width', '100%');
    element.style.setProperty('height', '100%');
    element.style.setProperty('padding', '8px 12px');
    element.style.setProperty('font', '18px/1.3 system-ui, sans-serif');
    element.style.setProperty('background', '#eef1f5');
    element.style.setProperty('color', '#1d2430');
    return element;
  };
  const adapter = (
    id: string,
    resolve: (key: string, signal: AbortSignal) => Promise<HTMLElement | null>,
  ): SurfaceAdapter<HTMLElement> =>
    Object.freeze({
      id,
      apiVersion: ADAPTER_API_VERSION,
      declaredCapabilities: SIMULATED_CAPABILITIES,
      resolve,
      capabilities: () => SIMULATED_CAPABILITIES,
      attach(handle: HTMLElement, target: { container: unknown }) {
        if (id === SIMULATED_ADAPTERS.throwing && attachFails) {
          throw new Error('the simulated adapter failed to attach');
        }
        if (!(target.container instanceof view.HTMLElement)) {
          throw new Error('simulated content can only be attached to an element');
        }
        target.container.append(handle);
      },
      update: () => undefined,
      detach(handle: HTMLElement) {
        handle.remove();
      },
    });
  const register = (failure: SimulatedFailure) => {
    const id = SIMULATED_ADAPTERS[failure];
    if (unregisters.has(id)) {
      return;
    }
    const made =
      failure === 'slow'
        ? adapter(
            id,
            (key, signal) =>
              new Promise<HTMLElement | null>((resolve, reject) => {
                const done = () => {
                  view.clearTimeout(timer);
                  slowReleases.delete(done);
                  resolve(simulatedContent(key));
                };
                const timer = view.setTimeout(done, slowMs);
                slowReleases.add(done);
                signal.addEventListener('abort', () => {
                  view.clearTimeout(timer);
                  slowReleases.delete(done);
                  reject(signal.reason as Error);
                });
              }),
          )
        : adapter(id, (key) => Promise.resolve(simulatedContent(key)));
    unregisters.set(id, runtime.registerAdapter(made));
  };
  register('slow');
  register('throwing');

  const windowId = (failure: SimulatedFailure) => `simulated-${failure}`;
  const simulated = (): Partial<Record<SimulatedFailure, Id>> =>
    Object.fromEntries(
      SIMULATED_FAILURES.filter((f) => workspace.getState().nodes.has(windowId(f))).map((f) => [
        f,
        windowId(f),
      ]),
    );

  let second: { viewport: PresentedViewport } | null = null;

  // The debug overlay.
  let overlay: HTMLCanvasElement | null = null;
  const draw = () => {
    const canvas = overlay;
    const frame = app.viewport.lastFrame();
    const ctx = canvas?.getContext('2d');
    if (canvas == null || ctx == null) {
      return;
    }
    const box = app.root.getBoundingClientRect();
    const ratio = view.devicePixelRatio;
    canvas.width = Math.max(1, Math.round(box.width * ratio));
    canvas.height = Math.max(1, Math.round(box.height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    if (frame === null) {
      return;
    }
    const palette = resolvePalette(document.documentElement);
    const ink = (name: string) => {
      const value = palette[name];
      if (value === undefined) {
        throw new Error(`the kit's palette has no colour "${name}"`);
      }
      return value;
    };
    const owner = ink('focusBorder');
    const duplicate = ink('editorWarning.foreground');
    const hit = ink('errorForeground');
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (const planned of frame.frame.planned) {
      const f = planned.fragment;
      const colour = f.nativeOwner ? owner : duplicate;
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.setLineDash(f.nativeOwner ? [] : [4, 3]);
      ctx.strokeRect(f.bounds[0] + 0.5, f.bounds[1] + 0.5, f.bounds[2] - 1, f.bounds[3] - 1);
      // The window's whole card, dotted, round the surface's place on it.
      ctx.setLineDash([2, 2]);
      ctx.strokeRect(f.card[0] + 0.5, f.card[1] + 0.5, f.card[2] - 1, f.card[3] - 1);
      // One logical target: every fragment names the one surface it stands for.
      ctx.setLineDash([]);
      ctx.fillText(
        `${f.surfaceId} #${String(f.ordinal)}${f.nativeOwner ? '' : ' (seam duplicate)'} · ${planned.negotiation.mode}`,
        f.bounds[0] + 3,
        f.bounds[1] + f.bounds[3] - 4,
      );
    }
    const target = input.lastTarget;
    if (target !== null && target.viewportId === VIEWPORT_ID) {
      ctx.strokeStyle = hit;
      ctx.fillStyle = hit;
      ctx.beginPath();
      ctx.moveTo(target.x - 8, target.y);
      ctx.lineTo(target.x + 8, target.y);
      ctx.moveTo(target.x, target.y - 8);
      ctx.lineTo(target.x, target.y + 8);
      ctx.stroke();
      ctx.fillText(
        `hit: ${target.surfaceId ?? target.nodeId ?? 'background'}${target.region === null ? '' : ` (${target.region})`}`,
        target.x + 10,
        target.y - 10,
      );
    }
  };
  const stopOverlay = app.presenter.subscribe((event) => {
    if (overlay !== null && event.type === 'frame' && event.viewportId === VIEWPORT_ID) {
      draw();
    }
  });

  return Object.freeze({
    diagnostics,
    trace,
    timeline: () => Object.freeze([...entries]),
    input: () =>
      Object.freeze({ ...input, byAdapter: { ...input.byAdapter }, cancels: { ...input.cancels } }),
    navigation: () =>
      Object.freeze({
        transitions: { ...navigation.transitions },
        focusTimes: { ...navigation.focusTimes },
        travelPx: navigation.travelPx,
      }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    simulate(failure: SimulatedFailure): Id {
      const id = windowId(failure);
      const state = workspace.getState();
      if (state.nodes.has(id)) {
        return id;
      }
      if (failure === 'throwing') {
        attachFails = true;
      }
      // Low in the room, out along the floor at its own heading.
      const h = (PLACES[failure] * Math.PI) / 180;
      const reach = 3;
      const y = -1.9;
      const layout = layoutSurfaces([[1.2, 0.7]]);
      const parentId = state.nodes.has(WORKSPACE_GROUP_ID) ? WORKSPACE_GROUP_ID : null;
      const commands: SceneCommand[] = [
        {
          type: 'node.create',
          node: {
            id,
            kind: 'window',
            parentId,
            label: `Simulated: ${failure}`,
            tags: ['simulated'],
            bounds: layout.bounds,
            transform: {
              position: [reach * Math.sin(h), y, -reach * Math.cos(h)],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          },
        },
        {
          type: 'surface.attach',
          surface: {
            id: `${id}-surface`,
            ownerNodeId: id,
            bindingKey: `simulated/${failure}`,
            adapterTypeId: SIMULATED_ADAPTERS[failure],
            label: `Simulated: ${failure}`,
            bounds: [1.2, 0.7, 0.01],
            transform: {
              position: layout.offsets[0] ?? [0, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          },
        },
      ];
      const result = workspace.transaction(commands, { source: 'host' });
      if (result.status !== 'committed') {
        throw new Error(`the ${failure} window could not be added: ${JSON.stringify(result)}`);
      }
      tell();
      return id;
    },
    simulated,
    async recover(failure: SimulatedFailure) {
      const surfaceId = `${windowId(failure)}-surface`;
      switch (failure) {
        case 'missing':
          // The host registers the adapter it lacked: the surface binds in place.
          register('missing');
          break;
        case 'slow':
          for (const release of [...slowReleases]) {
            release();
          }
          break;
        case 'throwing':
          attachFails = false;
          await runtime.bind(surfaceId);
          app.viewport.invalidate();
          break;
      }
      tell();
    },
    clearSimulated() {
      const ids = Object.values(simulated());
      if (ids.length > 0) {
        workspace.transaction(
          ids.map((id): SceneCommand => ({ type: 'node.delete', id, mode: 'subtree' })),
          { source: 'host' },
        );
      }
      const missing = unregisters.get(SIMULATED_ADAPTERS.missing);
      unregisters.delete(SIMULATED_ADAPTERS.missing);
      missing?.();
      tell();
    },
    async openSecondView(container: HTMLElement) {
      if (second !== null) {
        return second.viewport;
      }
      const box = container.getBoundingClientRect();
      const created = workspace.transaction(
        [
          {
            type: 'viewport.create',
            viewport: {
              id: SECOND_VIEWPORT_ID,
              cameraId: CAMERA_ID,
              mode: PANORAMA.id,
              projection: PANORAMA.projection,
              size: {
                width: Math.max(1, Math.round(box.width)),
                height: Math.max(1, Math.round(box.height)),
                devicePixelRatio: view.devicePixelRatio,
              },
            },
          },
        ],
        { source: 'host' },
      );
      if (created.status !== 'committed') {
        throw new Error(`the second view could not be created: ${JSON.stringify(created)}`);
      }
      const opened = await app.presenter.open({
        viewportId: SECOND_VIEWPORT_ID,
        container,
        backends: [
          { renderer: LAYERED_RENDERER_ID, compositor: LAYER_COMPOSITOR_ID },
          { renderer: DOM_RENDERER_ID, compositor: DOM_COMPOSITOR_ID },
        ],
        priority: 'background',
      });
      second = { viewport: opened };
      tell();
      return opened;
    },
    async closeSecondView() {
      const open = second;
      second = null;
      if (open === null) {
        return;
      }
      await open.viewport.dispose();
      workspace.transaction([{ type: 'viewport.delete', id: SECOND_VIEWPORT_ID }], {
        source: 'host',
      });
      tell();
    },
    secondView: () => second?.viewport ?? null,
    showOverlay(on: boolean) {
      if (on && overlay === null) {
        const canvas = document.createElement('canvas');
        canvas.dataset['referenceDebugOverlay'] = '';
        canvas.setAttribute('aria-hidden', 'true');
        for (const [name, value] of Object.entries({
          position: 'absolute',
          left: '0',
          top: '0',
          width: '100%',
          height: '100%',
          // It covers the view without taking any of its input (UX-008).
          'pointer-events': 'none',
          'z-index': '1',
        })) {
          canvas.style.setProperty(name, value);
        }
        app.root.append(canvas);
        overlay = canvas;
        draw();
      } else if (!on && overlay !== null) {
        overlay.remove();
        overlay = null;
      }
      tell();
    },
    overlayShown: () => overlay !== null,
    exportDiagnostics(disclosure: Partial<Disclosure>) {
      return exportDiagnostics({
        report: diagnostics.read(),
        scene: workspace.getState(),
        trace,
        disclosure,
        exportedAt: Date.now(),
        measures: {
          input: {
            ...input,
            byAdapter: { ...input.byAdapter },
            cancels: { ...input.cancels },
            lastTarget: input.lastTarget === null ? null : { ...input.lastTarget },
          },
          navigation: {
            transitions: { ...navigation.transitions },
            focusTimes: { ...navigation.focusTimes },
            travelPx: navigation.travelPx,
          },
          persistence: { ...app.workspaces.measures() },
        },
      });
    },
    async dispose() {
      for (const stop of stops.splice(0)) {
        stop();
      }
      stopOverlay();
      overlay?.remove();
      overlay = null;
      const open = second;
      second = null;
      if (open !== null) {
        await open.viewport.dispose();
        workspace.transaction([{ type: 'viewport.delete', id: SECOND_VIEWPORT_ID }], {
          source: 'host',
        });
      }
      for (const release of [...slowReleases]) {
        release();
      }
      for (const unregister of unregisters.values()) {
        unregister();
      }
      unregisters.clear();
      trace.dispose();
      diagnostics.dispose();
      listeners.clear();
    },
  });
}

/** The IDs an event's payload names, for the timeline: its string fields only. */
function idsOf(payload: object): string {
  return Object.entries(payload)
    .filter(([key, value]) => typeof value === 'string' && /id$/i.test(key))
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(', ');
}
