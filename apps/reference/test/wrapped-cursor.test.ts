import type { DispatchResult, InputAdapter, InputIntent, PointerIntent } from '@swf/interaction';
import { NO_MODIFIERS } from '@swf/interaction';
import type { Vec3 } from '@swf/math';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURES, updateFeatures } from '../src/features.js';
import type { WrapState } from '../src/wrapped-cursor.js';
import { afterDispatch, NO_POINTERS, wrappedInput, wrapPointer } from '../src/wrapped-cursor.js';
import { pointOn, policyWorld, screenOf, VIEWPORT, W } from './policy-world.js';

const sample = (phase: PointerIntent['phase'], x: number, pointerId = 1): PointerIntent => ({
  kind: 'pointer',
  viewportId: VIEWPORT,
  deviceId: 'mouse',
  pointerId,
  pointerType: 'mouse',
  phase,
  x,
  y: 100,
  buttons: phase === 'up' ? 0 : 1,
  modifiers: NO_MODIFIERS,
  timestamp: 0,
});

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

const WRAPS = { width: 800, wraps: true };

describe('the wrapped cursor, as plain transitions (FR-107, FR-123)', () => {
  it('wraps a pointer the framework took across the seam, and draws the virtual cursor there', () => {
    const taken: WrapState = afterDispatch(NO_POINTERS, sample('down', 780), answer(true));
    expect(wrapPointer(taken, sample('move', 790), WRAPS)).toEqual({
      intent: sample('move', 790),
      cursor: null,
    });
    const past = wrapPointer(taken, sample('move', 830), WRAPS);
    expect(past.intent.x).toBe(30);
    expect(past.cursor).toEqual({ x: 30, y: 100 });
    // Round the other way, and more than a whole view round.
    expect(wrapPointer(taken, sample('move', -25), WRAPS).intent.x).toBe(775);
    expect(wrapPointer(taken, sample('move', 1630), WRAPS).intent.x).toBe(30);
    // The release lands wrapped too, with no cursor left drawn.
    expect(wrapPointer(taken, sample('up', 830), WRAPS)).toMatchObject({
      intent: { x: 30 },
      cursor: null,
    });
    expect(afterDispatch(taken, sample('up', 830), answer(true))).toEqual(NO_POINTERS);
  });

  it('leaves alone pointers content kept, presses, and every pointer where the view does not wrap', () => {
    const native = afterDispatch(NO_POINTERS, sample('down', 780), answer(false));
    expect(native).toBe(NO_POINTERS);
    expect(wrapPointer(native, sample('move', 830), WRAPS).intent.x).toBe(830);
    const taken = afterDispatch(NO_POINTERS, sample('down', 780), answer(true));
    expect(wrapPointer(taken, sample('down', 830), WRAPS).intent.x).toBe(830);
    expect(wrapPointer(taken, sample('move', 830, 2), WRAPS).intent.x).toBe(830);
    expect(wrapPointer(taken, sample('move', 830), { width: 800, wraps: false })).toEqual({
      intent: sample('move', 830),
      cursor: null,
    });
    expect(() => wrapPointer(taken, sample('move', 830), { width: 0, wraps: true })).toThrow(
      RangeError,
    );
  });

  it('passes every intent through untouched while off, and takes the cursor away when disconnected', () => {
    let dispatch: ((intent: InputIntent) => DispatchResult) | null = null;
    const device: InputAdapter = {
      id: 'test.device/1',
      apiVersion: 1,
      connect(d) {
        dispatch = d;
        return () => {
          dispatch = null;
        };
      },
    };
    let on = false;
    const seen: InputIntent[] = [];
    const drawn: ({ x: number; y: number } | null)[] = [];
    const disconnect = wrappedInput({
      device,
      enabled: () => on,
      frame: () => WRAPS,
      cursor: (at) => drawn.push(at === null ? null : { ...at }),
    }).connect((intent) => {
      seen.push(intent);
      return answer(true);
    });
    const send = (intent: InputIntent) =>
      (dispatch as unknown as (i: InputIntent) => DispatchResult)(intent);
    send(sample('down', 780));
    send(sample('move', 830));
    expect((seen[1] as PointerIntent).x).toBe(830);
    on = true;
    send(sample('move', 840));
    expect((seen[2] as PointerIntent).x).toBe(40);
    expect(drawn).toEqual([{ x: 40, y: 100 }]);
    disconnect();
    expect(drawn).toEqual([{ x: 40, y: 100 }, null]);
  });
});

describe('dragging across the seam (§33.2 scenario 2, FR-065, FR-104, FR-123)', () => {
  /** Presses window-01 (on the seam behind the camera) left of its centre and drags it right past the view's edge. */
  function seamDrag(features = updateFeatures(DEFAULT_FEATURES, { enabled: { snap: false } })) {
    const w = policyWorld('seam', features);
    const grabbed: Vec3 = [-0.6, 0, 0];
    const [x, y] = screenOf(w.ws, pointOn(w.ws, 'window-01', grabbed), W);
    expect(x).toBeGreaterThan(W - 40);
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
    const [ax, ay] = screenOf(w.ws, pointOn(w.ws, 'window-01', grabbed), 45);
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

  it('holds the window at the edge without the wrapped cursor: a pointer past it has no place', () => {
    const { w, grabbed } = seamDrag(
      updateFeatures(DEFAULT_FEATURES, { enabled: { snap: false, cursor: false } }),
    );
    const [ax] = screenOf(w.ws, pointOn(w.ws, 'window-01', grabbed), W);
    // It got no further than the last place the pointer was in the view.
    expect(ax).toBeGreaterThan(W - 2);
  });

  it('keeps the target and undoes as one change with every policy on, snapping included', () => {
    const { w, grabbed, before, history } = seamDrag(DEFAULT_FEATURES);
    expect(w.events.filter((e) => e.type === 'gesture.started')).toHaveLength(1);
    const [ax] = screenOf(w.ws, pointOn(w.ws, 'window-01', grabbed), 45);
    // A snap may turn it, by no more than the line-up angle (2°, under 5 px here).
    expect(Math.abs(ax - 45)).toBeLessThan(5);
    expect(w.ws.history()).toHaveLength(history + 1);
    w.ws.undo({ source: 'user' });
    expect(w.ws.getState().nodes.get('window-01')?.transform).toEqual(
      before.nodes.get('window-01')?.transform,
    );
  });
});
