import type { DomPointerLock, PointerLockChange } from '@swf/backend-dom';
import type {
  DispatchResult,
  InputAdapter,
  InputIntent,
  InteractionEvent,
  KeyIntent,
  PointerIntent,
} from '@swf/interaction';
import { NO_MODIFIERS } from '@swf/interaction';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURES, updateFeatures, wrappedInput } from '@swf/navigation';
import type { PolicyWorld } from './policy-world.js';
import { onCard, policyWorld, VIEWPORT, W } from './policy-world.js';

const sample = (
  phase: PointerIntent['phase'],
  x: number,
  more: Partial<PointerIntent> = {},
): PointerIntent => ({
  kind: 'pointer',
  viewportId: VIEWPORT,
  deviceId: 'mouse',
  pointerId: 1,
  pointerType: 'mouse',
  phase,
  x,
  y: 100,
  buttons: phase === 'up' || phase === 'cancel' ? 0 : 1,
  modifiers: NO_MODIFIERS,
  timestamp: 0,
  ...more,
});

/** A sample of a locked pointer: frozen at (x, 100), moved by (dx, dy). */
const locked = (phase: PointerIntent['phase'], x: number, dx: number, dy = 0) =>
  sample(phase, x, { movement: { x: dx, y: dy } });
/**
 * The first sample once the lock holds, frozen at (x, 100): its motion is the platform's own, as
 * Chromium reports it, from where it froze the pointer to the page's corner.
 */
const warp = (x: number) => locked('move', x, -x, -100);

const escape: KeyIntent = {
  kind: 'key',
  viewportId: VIEWPORT,
  deviceId: 'keyboard',
  phase: 'down',
  key: 'Escape',
  repeat: false,
  modifiers: NO_MODIFIERS,
  focus: 'workspace',
  timestamp: 0,
};

const answer = (consumed: boolean): DispatchResult => ({
  consumed,
  route: consumed ? 'gesture' : 'native',
  region: null,
  target: null,
  gestureId: null,
  operation: null,
  reason: null,
  pick: null,
});

const WRAPS = { width: 800, height: 400, wraps: true };

/**
 * The wrapped cursor between a device and a framework that consumes every press (or none), with a
 * platform lock that answers when told to, and the router's notifications in the test's hands.
 */
function rig(
  options: {
    lockable?: boolean;
    consumes?: boolean;
    frame?: typeof WRAPS;
    on?: () => boolean;
  } = {},
) {
  let device: ((intent: InputIntent) => DispatchResult) | null = null;
  const adapter: InputAdapter = {
    id: 'test.device/1',
    apiVersion: 1,
    connect(d) {
      device = d;
      return () => {
        device = null;
      };
    },
  };
  const lockListeners = new Set<(change: PointerLockChange) => void>();
  const platform: string[] = [];
  const lock: DomPointerLock = {
    available: options.lockable ?? true,
    request() {
      platform.push('request');
    },
    exit() {
      platform.push('exit');
    },
    subscribe(listener) {
      lockListeners.add(listener);
      return () => lockListeners.delete(listener);
    },
  };
  const routerListeners = new Set<(event: InteractionEvent) => void>();
  const seen: InputIntent[] = [];
  const drawn: ({ x: number; y: number } | null)[] = [];
  const disconnect = wrappedInput({
    device: adapter,
    lock,
    viewportId: VIEWPORT,
    events: (listener) => {
      routerListeners.add(listener);
      return () => routerListeners.delete(listener);
    },
    enabled: options.on ?? (() => true),
    frame: () => options.frame ?? WRAPS,
    cursor: (at) => drawn.push(at === null ? null : { ...at }),
  }).connect((intent) => {
    seen.push(intent);
    return answer(options.consumes ?? true);
  });
  const send = (intent: InputIntent) =>
    (device as unknown as (i: InputIntent) => DispatchResult)(intent);
  const platformSays = (change: PointerLockChange) => {
    for (const listener of lockListeners) {
      listener(change);
    }
  };
  const routerReleases = (pointerId = 1) => {
    for (const listener of routerListeners) {
      listener({ type: 'capture.released', pointerId, deviceId: 'mouse', viewportId: VIEWPORT });
    }
  };
  const lastPlace = () => {
    const p = seen.at(-1) as PointerIntent;
    return [p.phase, p.x, p.y];
  };
  return { send, platformSays, routerReleases, seen, drawn, platform, lastPlace, disconnect };
}

describe('the wrapped cursor (FR-107, FR-123)', () => {
  it('wraps a pointer the framework took across the seam, and draws the virtual cursor there', () => {
    const r = rig({ lockable: false });
    r.send(sample('down', 780));
    r.send(sample('move', 790));
    expect(r.lastPlace()).toEqual(['move', 790, 100]);
    r.send(sample('move', 830));
    expect(r.lastPlace()).toEqual(['move', 30, 100]);
    expect(r.drawn).toEqual([{ x: 30, y: 100 }]);
    // Round the other way, and more than a whole view round.
    r.send(sample('move', -25));
    expect(r.lastPlace()).toEqual(['move', 775, 100]);
    r.send(sample('move', 1630));
    expect(r.lastPlace()).toEqual(['move', 30, 100]);
    // The release lands wrapped too, with no cursor left drawn.
    r.send(sample('up', 830));
    expect(r.lastPlace()).toEqual(['up', 30, 100]);
    expect(r.drawn.at(-1)).toBeNull();
    // Where the platform offers no lock, none is asked for: the drag stops where its pointer does.
    expect(r.platform).toEqual([]);
  });

  it('leaves alone pointers content kept, presses, other pointers, and every pointer where the view does not wrap', () => {
    const native = rig({ consumes: false });
    native.send(sample('down', 780));
    native.send(sample('move', 830));
    expect(native.lastPlace()).toEqual(['move', 830, 100]);
    expect(native.platform).toEqual([]);
    const r = rig();
    r.send(sample('down', 830));
    expect(r.lastPlace()).toEqual(['down', 830, 100]);
    r.send(sample('move', 830, { pointerId: 2 }));
    expect(r.lastPlace()).toEqual(['move', 830, 100]);
    const flat = rig({ frame: { ...WRAPS, wraps: false } });
    flat.send(sample('down', 780));
    flat.send(sample('move', 830));
    expect(flat.lastPlace()).toEqual(['move', 830, 100]);
    expect(flat.platform).toEqual([]);
    expect(() => rig({ frame: { ...WRAPS, width: 0 } }).send(sample('move', 830))).toThrow(/width/);
    expect(() => r.send(locked('move', 400, NaN))).toThrow(/movement/);
  });

  it('passes every intent through untouched while off, and takes the cursor away when disconnected', () => {
    let on = false;
    const r = rig({ on: () => on, lockable: false });
    r.send(sample('down', 780));
    r.send(sample('move', 830));
    expect(r.lastPlace()).toEqual(['move', 830, 100]);
    on = true;
    r.send(sample('move', 840));
    expect(r.lastPlace()).toEqual(['move', 40, 100]);
    expect(r.drawn).toEqual([{ x: 40, y: 100 }]);
    r.disconnect();
    expect(r.drawn).toEqual([{ x: 40, y: 100 }, null]);
  });

  it('asks for the lock when a held mouse reaches the edge, and carries the drag on round the circle by its motion', () => {
    const r = rig();
    r.send(sample('down', 700));
    r.send(sample('move', 797));
    expect(r.platform).toEqual([]);
    // On the view's last two pixels: where the platform's pointer stops at the screen's edge.
    r.send(sample('move', 798.5));
    expect(r.platform).toEqual(['request']);
    r.send(sample('move', 798));
    expect(r.platform).toEqual(['request']);
    r.platformSays('locked');
    // The platform's pointer is hidden: the virtual cursor shows where it was last passed on.
    expect(r.drawn.at(-1)).toEqual({ x: 798, y: 100 });
    // The platform's own motion as the lock takes hold moves nothing.
    r.send(warp(798));
    expect(r.lastPlace()).toEqual(['move', 798, 100]);
    expect(r.drawn.at(-1)).toEqual({ x: 798, y: 100 });
    // The place the platform reports stays frozen; the motion carries the drag on, past the seam.
    r.send(locked('move', 798, 30));
    expect(r.lastPlace()).toEqual(['move', 28, 100]);
    r.send(locked('move', 798, 1600, -20));
    expect(r.lastPlace()).toEqual(['move', 28, 80]);
    expect(r.drawn.at(-1)).toEqual({ x: 28, y: 80 });
    // Kept within the view's height, where its cursor can be seen, and back from there at once.
    r.send(locked('move', 798, 0, -500));
    expect(r.lastPlace()).toEqual(['move', 28, 0]);
    r.send(locked('move', 798, 0, 10));
    expect(r.lastPlace()).toEqual(['move', 28, 10]);
    // The release lands where the virtual cursor is, and lets the lock go.
    r.send(locked('up', 798, -40));
    expect(r.lastPlace()).toEqual(['up', 788, 10]);
    expect(r.platform).toEqual(['request', 'exit']);
    expect(r.drawn.at(-1)).toBeNull();
    r.platformSays('unlocked');
    expect(r.seen.filter((i) => i.kind === 'pointer' && i.phase === 'cancel')).toEqual([]);
  });

  it('never asks for the lock for touch or a pen, nor for the left edge before a move', () => {
    const touch = rig();
    touch.send(sample('down', 700, { pointerType: 'touch' }));
    touch.send(sample('move', 799, { pointerType: 'touch' }));
    expect(touch.platform).toEqual([]);
    const r = rig();
    r.send(sample('down', 1));
    expect(r.platform).toEqual([]);
    r.send(sample('move', 2));
    expect(r.platform).toEqual([]);
    r.send(sample('move', 1.5));
    expect(r.platform).toEqual(['request']);
  });

  it('lets the lock go and ends the drag on Escape, where the virtual cursor was', () => {
    const r = rig();
    r.send(sample('down', 700));
    r.send(sample('move', 799));
    r.platformSays('locked');
    r.send(warp(799));
    r.send(locked('move', 799, 51));
    r.send(escape);
    expect(r.platform).toEqual(['request', 'exit']);
    expect(r.lastPlace()).toEqual(['cancel', 50, 100]);
    expect(r.drawn.at(-1)).toBeNull();
  });

  it('lets the lock go when the framework ends the gesture, before Escape would', () => {
    const r = rig();
    r.send(sample('down', 700));
    r.send(sample('move', 799));
    r.platformSays('locked');
    r.routerReleases();
    expect(r.platform).toEqual(['request', 'exit']);
    expect(r.drawn.at(-1)).toBeNull();
    r.send(escape);
    // Escape after the gesture ended cancels nothing more.
    expect(r.seen.at(-1)).toBe(escape);
    // The pointer is let go: past the edge it is no longer wrapped.
    r.platformSays('unlocked');
    r.send(sample('move', 830));
    expect(r.lastPlace()).toEqual(['move', 830, 100]);
  });

  it('ends the drag where it was when the platform takes the lock away', () => {
    const r = rig();
    r.send(sample('down', 700));
    r.send(sample('move', 799));
    r.platformSays('locked');
    r.send(warp(799));
    r.send(locked('move', 799, 11, 5));
    r.platformSays('unlocked');
    expect(r.lastPlace()).toEqual(['cancel', 10, 105]);
    expect(r.drawn.at(-1)).toBeNull();
    expect(r.platform).toEqual(['request']);
  });

  it('asks once a stroke: a refusal holds until the pointer is let go, and the drag wraps as far as the pointer goes', () => {
    const r = rig();
    r.send(sample('down', 700));
    r.send(sample('move', 799));
    r.platformSays('refused');
    r.send(sample('move', 830));
    expect(r.lastPlace()).toEqual(['move', 30, 100]);
    expect(r.platform).toEqual(['request']);
    r.send(sample('up', 830));
    r.send(sample('down', 700));
    r.send(sample('move', 799));
    expect(r.platform).toEqual(['request', 'request']);
  });

  it('lets go a lock that arrives after its drag ended, and one on disconnecting', () => {
    const r = rig();
    r.send(sample('down', 700));
    r.send(sample('move', 799));
    r.send(sample('up', 799));
    expect(r.platform).toEqual(['request', 'exit']);
    r.platformSays('locked');
    expect(r.platform).toEqual(['request', 'exit', 'exit']);
    expect(r.drawn).toEqual([]);
    r.platformSays('unlocked');
    r.send(sample('down', 700));
    r.send(sample('move', 799));
    r.platformSays('locked');
    r.disconnect();
    expect(r.platform).toEqual(['request', 'exit', 'exit', 'request', 'exit']);
    expect(r.drawn.at(-1)).toBeNull();
  });
});

describe('dragging across the seam (§33.2 scenario 2, FR-065, FR-104, FR-123)', () => {
  /** Where a point of window-01's card is across the view, brought into it (0 to W). */
  const across = (w: PolicyWorld, local: readonly [number, number]) => {
    const [x, y] = onCard(w, 'window-01', local);
    return [((x % W) + W) % W, y] as const;
  };

  /** Presses window-01 (on the seam behind the camera) left of its centre and drags it right past the view's edge. */
  function seamDrag(features = updateFeatures(DEFAULT_FEATURES, { enabled: { snap: false } })) {
    const w = policyWorld('seam', features);
    const grabbed = [-0.6, 0] as const;
    const [x, y] = across(w, grabbed);
    expect(x).toBeGreaterThan(W - 100);
    const before = w.ws.getState();
    const history = w.ws.history().length;
    w.input.pointer('down', VIEWPORT, x, y, { modifiers: { alt: true } });
    const steps = [x + 10, W - 1, W + 10, W + 30, W + 45];
    for (const step of steps) {
      w.input.pointer('move', VIEWPORT, step, y);
    }
    w.input.pointer('up', VIEWPORT, W + 45, y, { buttons: 0 });
    return { w, grabbed, before, history, y };
  }

  it('keeps the target and the grabbed point under the wrapped pointer, and undo restores exactly one change', () => {
    const { w, grabbed, before, history, y } = seamDrag();
    const started = w.events.filter((e) => e.type === 'gesture.started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ operation: 'node.move', nodeId: 'window-01' });
    // Only the grabbed window moved, through the seam to the far side of it.
    const after = w.ws.getState();
    for (const node of before.nodes.values()) {
      if (node.id !== 'window-01') {
        expect(after.nodes.get(node.id)).toBe(node);
      }
    }
    const [ax, ay] = across(w, grabbed);
    expect(ax).toBeCloseTo(45, 6);
    expect(ay).toBeCloseTo(y, 6);
    expect(w.ws.history()).toHaveLength(history + 1);
    w.ws.undo({ source: 'user' });
    expect(w.ws.getState().nodes.get('window-01')?.transform).toEqual(
      before.nodes.get('window-01')?.transform,
    );
    expect(w.ws.canUndo()).toBe(w.ws.history().length > 0);
    expect(w.ws.history()).toHaveLength(history);
  });

  it('carries the window on by the pointer’s motion without the wrapped cursor, which only keeps the pointer in view', () => {
    const { w, grabbed } = seamDrag(
      updateFeatures(DEFAULT_FEATURES, { enabled: { snap: false, cursor: false } }),
    );
    // The window went as far round as the pointer moved, past the edge and over the seam.
    expect(across(w, grabbed)[0]).toBeCloseTo(45, 6);
  });

  it('keeps the target and undoes as one change with every policy on, snapping included', () => {
    const { w, grabbed, before, history } = seamDrag(DEFAULT_FEATURES);
    expect(w.events.filter((e) => e.type === 'gesture.started')).toHaveLength(1);
    const [ax] = across(w, grabbed);
    // A snap may turn it, by no more than the line-up angle (2°, under 5 px here).
    expect(Math.abs(ax - 45)).toBeLessThan(5);
    expect(w.ws.history()).toHaveLength(history + 1);
    w.ws.undo({ source: 'user' });
    expect(w.ws.getState().nodes.get('window-01')?.transform).toEqual(
      before.nodes.get('window-01')?.transform,
    );
  });
});
