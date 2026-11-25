import type { Id, Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import type {
  BindingContext,
  PresentationHint,
  PresentationTarget,
  RuntimeEvent,
  SurfaceAdapter,
  SurfaceCapabilities,
  SurfaceRuntime,
} from '@swf/surfaces';
import { createSurfaceRuntime, exceededCapabilities } from '@swf/surfaces';
import type { ConformanceCase } from './harness.js';
import { check, ConformanceFailure, sleep, until } from './harness.js';

/**
 * What the adapter suite needs from an adapter's author: a way to create fresh adapters and the
 * binding keys that exercise them. Optional hooks enable the cases that need them; without them
 * those cases report `not-applicable`.
 */
export interface AdapterFixture<THandle> {
  /**
   * A fresh adapter, with no state shared with any made before: each case registers its own in a
   * workspace and surface runtime of its own.
   */
  create(): SurfaceAdapter<THandle>;
  /** The binding keys the cases bind surfaces with. */
  readonly keys: {
    /** Two distinct keys that resolve to endpoints. */
    readonly valid: readonly [string, string];
    /** A key the adapter does not know: resolve answers null. */
    readonly unknown: string;
    /** A key whose resolution fails. */
    readonly failing?: string;
    /** A key whose resolution does not answer until cancelled (or completed by the fixture). */
    readonly slow?: string;
  };
  /** Makes the adapter answer its oldest pending resolution of `key`, late. */
  readonly completeSlow?: (adapter: SurfaceAdapter<THandle>, key: string) => void;
  /** Makes the adapter announce a capability change through the given binding context. */
  readonly changeCapabilities?: (adapter: SurfaceAdapter<THandle>, context: BindingContext) => void;
  /** The presentation container for a viewport. Default: an empty object. */
  readonly container?: (viewportId: Id) => unknown;
  /** How long a cancelled resolution may take to settle, in milliseconds. Default 1000. */
  readonly settleMs?: number;
}

interface Recorded {
  readonly method: 'resolve' | 'capabilities' | 'attach' | 'update' | 'detach';
  readonly handle?: unknown;
  readonly target?: PresentationTarget;
  readonly key?: string;
}

/** The author's adapter, recording every call the framework makes to it. */
class Recorder<THandle> {
  readonly calls: Recorded[] = [];
  readonly signals: AbortSignal[] = [];
  readonly contexts: BindingContext[] = [];
  readonly resolved: unknown[] = [];
  pending = 0;
  readonly adapter: SurfaceAdapter<THandle>;
  readonly inner: SurfaceAdapter<THandle>;

  constructor(inner: SurfaceAdapter<THandle>) {
    this.inner = inner;
    this.adapter = {
      id: inner.id,
      apiVersion: inner.apiVersion,
      declaredCapabilities: inner.declaredCapabilities,
      ...(inner.untimedBinding === undefined ? {} : { untimedBinding: inner.untimedBinding }),
      resolve: (key: string, signal: AbortSignal, context: BindingContext) => {
        this.calls.push({ method: 'resolve', key });
        this.signals.push(signal);
        this.contexts.push(context);
        this.pending += 1;
        return inner.resolve(key, signal, context).then(
          (handle) => {
            this.pending -= 1;
            this.resolved.push(handle);
            return handle;
          },
          (error: unknown) => {
            this.pending -= 1;
            throw error;
          },
        );
      },
      capabilities: (handle: THandle): SurfaceCapabilities => {
        this.calls.push({ method: 'capabilities', handle });
        return inner.capabilities(handle);
      },
      attach: (handle: THandle, target: PresentationTarget) => {
        this.calls.push({ method: 'attach', handle, target });
        return inner.attach(handle, target);
      },
      update: (handle: THandle, hint: PresentationHint) => {
        this.calls.push({ method: 'update', handle });
        inner.update(handle, hint);
      },
      detach: (handle: THandle, target: PresentationTarget) => {
        this.calls.push({ method: 'detach', handle, target });
        return inner.detach(handle, target);
      },
    };
  }

  of(method: Recorded['method']): Recorded[] {
    return this.calls.filter((c) => c.method === method);
  }
}

interface Harness<THandle> {
  readonly workspace: Workspace;
  readonly runtime: SurfaceRuntime;
  readonly recorder: Recorder<THandle>;
  readonly events: RuntimeEvent[];
  attach(surfaceId: Id, key: string): void;
  state(surfaceId: Id): string | undefined;
  close(): Promise<void>;
}

const OWNER = 'conformance-window';

function harness<THandle>(fixture: AdapterFixture<THandle>, timeoutMs?: number): Harness<THandle> {
  const workspace = createWorkspace({ id: 'conformance' });
  const runtime = createSurfaceRuntime(
    workspace,
    timeoutMs === undefined ? {} : { bindingTimeoutMs: timeoutMs },
  );
  const recorder = new Recorder(fixture.create());
  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  runtime.registerAdapter(recorder.adapter);
  const created = workspace.dispatch({
    type: 'node.create',
    node: { id: OWNER, kind: 'window', bounds: [1.6, 0.9, 0.01] },
  });
  check(created.status === 'committed', 'the conformance workspace could not create its window');
  return {
    workspace,
    runtime,
    recorder,
    events,
    attach(surfaceId, key) {
      const result = workspace.dispatch({
        type: 'surface.attach',
        surface: {
          id: surfaceId,
          ownerNodeId: OWNER,
          bindingKey: key,
          adapterTypeId: recorder.adapter.id,
          bounds: [1.6, 0.9, 0.01],
        },
      });
      check(result.status === 'committed', `surface "${surfaceId}" could not be attached`);
    },
    state: (surfaceId) => runtime.get(surfaceId)?.state,
    async close() {
      await workspace.dispose();
      await runtime.dispose();
    },
  };
}

const WAIT = 2000;

/**
 * The adapter conformance cases: binding success, unknown keys, failure, timeout, cancellation,
 * late resolution, attach/detach symmetry, safe and unsafe detachment, viewport sharing,
 * replacement with rollback, lifecycle event order and capability changes. Nothing runs until a
 * case's `run` is called; each run creates its own adapter, workspace and surface runtime.
 */
export function adapterConformance<THandle>(fixture: AdapterFixture<THandle>): ConformanceCase[] {
  const container = (viewportId: Id) => fixture.container?.(viewportId) ?? {};
  const settleMs = fixture.settleMs ?? 1000;
  const [first, second] = fixture.keys.valid;
  const bound = async (h: Harness<THandle>, surfaceId: Id, key: string) => {
    h.attach(surfaceId, key);
    await until(
      () => h.state(surfaceId) === 'ready' || h.state(surfaceId) === 'error',
      WAIT,
      `"${key}" to bind`,
    );
    const presentation = h.runtime.get(surfaceId);
    check(
      presentation?.state === 'ready',
      `key "${key}" did not bind: ${presentation?.error?.message ?? String(presentation?.state)}`,
    );
  };
  const cases: { name: string; run: () => Promise<'passed' | 'not-applicable'> }[] = [
    {
      name: 'registers with a versioned contract and consistent declared capabilities',
      async run() {
        const h = harness(fixture);
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'binds a valid key to a handle within its declared capabilities, changing no scene state',
      async run() {
        const h = harness(fixture);
        const revision = h.workspace.getState().revision + 1;
        await bound(h, 's', first);
        const capabilities = h.runtime.get('s')?.capabilities;
        check(
          capabilities !== null && capabilities !== undefined,
          'no capabilities were negotiated',
        );
        const exceeded = exceededCapabilities(
          h.recorder.adapter.declaredCapabilities,
          capabilities,
        );
        check(
          exceeded.length === 0,
          `the handle claims more than declared: ${exceeded.join(', ')}`,
        );
        const asked = h.recorder.of('capabilities')[0]?.handle;
        check(
          asked === h.recorder.resolved[0],
          'capabilities() was not asked about the resolved handle',
        );
        check(h.workspace.getState().revision === revision, 'binding changed the scene');
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'answers an unknown key with null, leaving an unbound placeholder rather than an error',
      async run() {
        const h = harness(fixture);
        h.attach('s', fixture.keys.unknown);
        await until(
          () => h.state('s') !== 'binding' && h.state('s') !== undefined,
          WAIT,
          'the unknown key to settle',
        );
        const p = h.runtime.get('s');
        check(
          p?.state === 'unbound' && p.unboundReason === 'unknown-binding-key',
          `an unknown key left the surface ${String(p?.state)} (${p?.error?.message ?? String(p?.unboundReason)})`,
        );
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'fails a failing key as a retryable error isolated to its surface',
      async run() {
        const failing = fixture.keys.failing;
        if (failing === undefined) {
          return 'not-applicable';
        }
        const h = harness(fixture);
        h.attach('bad', failing);
        await bound(h, 'good', first);
        await until(() => h.state('bad') === 'error', WAIT, 'the failing key to fail');
        check(h.runtime.get('bad')?.error?.retryable === true, 'the failure is not retryable');
        check(h.state('good') === 'ready', 'a failing key disturbed another surface');
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'gives up a binding that never answers when the timeout passes, aborting it',
      async run() {
        const slow = fixture.keys.slow;
        if (slow === undefined || fixture.create().untimedBinding === true) {
          return 'not-applicable';
        }
        const h = harness(fixture, 30);
        h.attach('s', slow);
        await until(() => h.state('s') === 'error', WAIT, 'the binding to time out');
        check(
          h.runtime.get('s')?.error?.details?.['reason'] === 'timeout',
          'the error is not a timeout',
        );
        check(h.recorder.signals[0]?.aborted === true, 'the abort signal did not fire on timeout');
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'stops resolving once its binding is cancelled',
      async run() {
        const slow = fixture.keys.slow;
        if (slow === undefined) {
          return 'not-applicable';
        }
        const h = harness(fixture);
        h.attach('s', slow);
        await until(() => h.recorder.pending === 1, WAIT, 'the slow resolution to start');
        const removed = h.workspace.dispatch({ type: 'surface.detach', id: 's' });
        check(removed.status === 'committed', 'the surface could not be removed');
        check(
          h.recorder.signals[0]?.aborted === true,
          'removing the surface did not abort its binding',
        );
        try {
          await until(
            () => h.recorder.pending === 0,
            settleMs,
            'the cancelled resolution to settle',
          );
        } catch {
          throw new ConformanceFailure(
            `the adapter kept resolving for more than ${String(settleMs)} ms after its abort signal fired`,
          );
        }
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'has a late answer for a removed surface discarded, never attached',
      async run() {
        const slow = fixture.keys.slow;
        const complete = fixture.completeSlow;
        if (slow === undefined || complete === undefined) {
          return 'not-applicable';
        }
        const h = harness(fixture);
        h.attach('s', slow);
        await until(() => h.recorder.pending === 1, WAIT, 'the slow resolution to start');
        h.workspace.dispatch({ type: 'surface.detach', id: 's' });
        try {
          complete(h.recorder.inner, slow);
        } catch {
          // An adapter that honoured the abort has nothing left to complete.
        }
        await sleep(5);
        check(h.recorder.of('attach').length === 0, 'a late answer was attached');
        check(h.runtime.get('s') === undefined, 'the removed surface came back');
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'is detached with exactly the handle and target it was attached with',
      async run() {
        const h = harness(fixture);
        await bound(h, 's', first);
        const presented = await h.runtime.present('s', 'v1', container('v1'));
        check(
          presented.status === 'ok',
          `presenting failed: ${presented.status === 'rejected' ? presented.error.message : ''}`,
        );
        h.workspace.dispatch({ type: 'surface.detach', id: 's' });
        await until(() => h.recorder.of('detach').length > 0, WAIT, 'the detach');
        const [attach] = h.recorder.of('attach');
        const detaches = h.recorder.of('detach');
        check(detaches.length === 1, `detach was called ${String(detaches.length)} times`);
        check(detaches[0]?.handle === attach?.handle, 'detach got a different handle than attach');
        check(detaches[0]?.target === attach?.target, 'detach got a different target than attach');
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'is released when hidden only if it declares safe detachment',
      async run() {
        const h = harness(fixture);
        await bound(h, 's', first);
        await h.runtime.present('s', 'v1', container('v1'));
        const safe = h.runtime.get('s')?.capabilities?.safeDetach === true;
        const hidden = await h.runtime.hide('s', 'v1', { release: true });
        check(hidden.status === 'ok', 'hiding failed');
        const detached = h.recorder.of('detach').length;
        if (safe) {
          check(
            detached === 1 && h.state('s') === 'ready',
            'a safely detachable surface was not released',
          );
        } else {
          check(detached === 0 && h.state('s') === 'hidden', 'an unsafe surface was released');
        }
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'is presented in several viewports only when its handle can be shared',
      async run() {
        const h = harness(fixture);
        await bound(h, 's', first);
        const shared = h.runtime.get('s')?.capabilities?.viewportSharing === 'shared';
        await h.runtime.present('s', 'v1', container('v1'));
        const again = await h.runtime.present('s', 'v2', container('v2'));
        const attaches = h.recorder.of('attach');
        if (shared) {
          check(
            again.status === 'ok' && attaches.length === 2,
            'a shared handle was not shown in two viewports',
          );
          check(attaches[0]?.target !== attaches[1]?.target, 'two viewports got the same target');
        } else {
          check(
            again.status === 'rejected' && again.error.code === 'UNSUPPORTED_CAPABILITY',
            'a single-owner handle was not refused a second viewport',
          );
          check(attaches.length === 1, 'a single-owner handle was attached twice');
        }
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'keeps its binding when a replacement fails, and hands off cleanly when one succeeds',
      async run() {
        const h = harness(fixture);
        await bound(h, 's', first);
        await h.runtime.present('s', 'v1', container('v1'));
        const old = h.runtime.handleOf('s');
        const failed = await h.runtime.replaceBinding('s', { bindingKey: fixture.keys.unknown });
        check(failed.status === 'rejected', 'replacing with an unknown key succeeded');
        check(
          h.runtime.handleOf('s') === old && h.state('s') === 'presented',
          'a failed replacement lost the old binding',
        );
        check(
          h.recorder.of('detach').length === 0,
          'a failed replacement detached the old endpoint',
        );
        const replaced = await h.runtime.replaceBinding('s', { bindingKey: second });
        check(replaced.status === 'ok', `replacing with "${second}" failed`);
        const order = h.recorder.calls.filter(
          (c) => c.method === 'attach' || c.method === 'detach',
        );
        const newAttach = order.findIndex((c, i) => i > 0 && c.method === 'attach');
        const oldDetach = order.findIndex((c) => c.method === 'detach' && c.handle === old);
        check(
          newAttach >= 0 && oldDetach > newAttach,
          'the old endpoint was released before the new one was attached',
        );
        check(
          h.recorder.of('detach').length === 1,
          'the handoff released more than the old attachment',
        );
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'goes through its lifecycle with events in order',
      async run() {
        const h = harness(fixture);
        await bound(h, 's', first);
        await h.runtime.present('s', 'v1', container('v1'));
        await h.runtime.hide('s', 'v1');
        h.workspace.dispatch({ type: 'surface.detach', id: 's' });
        await until(() => h.runtime.get('s') === undefined, WAIT, 'the surface to be released');
        const seen = h.events.flatMap((e) =>
          e.type === 'presentation.stateChanged' && e.payload.surfaceId === 's'
            ? [`${e.payload.from ?? 'none'}>${e.payload.to}`]
            : [],
        );
        const expected = [
          'none>unbound',
          'unbound>binding',
          'binding>ready',
          'ready>presented',
          'presented>hidden',
          'hidden>detaching',
          'detaching>detached',
        ];
        check(seen.join(' ') === expected.join(' '), `events were ${seen.join(' ')}`);
        await h.close();
        return 'passed';
      },
    },
    {
      name: 'announces only capability changes within its declaration',
      async run() {
        const change = fixture.changeCapabilities;
        if (change === undefined) {
          return 'not-applicable';
        }
        const h = harness(fixture);
        await bound(h, 's', first);
        const context = h.recorder.contexts[0];
        check(context !== undefined, 'no binding context was given');
        change(h.recorder.inner, context);
        await until(
          () =>
            h.events.some((e) => e.type === 'presentation.capabilitiesChanged') ||
            h.state('s') === 'error',
          WAIT,
          'the capability change',
        );
        check(
          h.state('s') === 'ready',
          `the announced capabilities were refused: ${h.runtime.get('s')?.error?.message ?? ''}`,
        );
        await h.close();
        return 'passed';
      },
    },
  ];
  return cases;
}
