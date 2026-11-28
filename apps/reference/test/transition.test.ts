import type { Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import { createPresentationRegistry } from '@swf/presentation';
import { createProjectionRegistry, equirectangular, headingPitchOf } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import { planPreset, presetCommands } from '../src/presets.js';
import type { ViewTransitions } from '@swf/navigation';
import {
  CAMERA_ID,
  FOCUS_ID,
  PANORAMA,
  TRANSITION_MS,
  TRANSITION_PREVIEW,
  createFocusMode,
  createModes,
  createViewTransitions,
} from '@swf/navigation';

/** Frames run when the test says, as a page's animation frames run when the browser says. */
class Frames {
  #pending: (() => unknown)[] = [];
  request(run: () => unknown): () => void {
    this.#pending.push(run);
    return () => {
      this.#pending = this.#pending.filter((r) => r !== run);
    };
  }
  run(): void {
    const due = this.#pending;
    this.#pending = [];
    for (const run of due) {
      run();
    }
  }
  get pending(): number {
    return this.#pending.length;
  }
}

function scene(motion = true) {
  const ws = createWorkspace({ id: 'test' });
  const projections = createProjectionRegistry({
    kinds: ws.mutator(),
    projectors: createPresentationRegistry().registrar(),
  });
  projections.register(equirectangular);
  expect(
    ws.transaction([
      { type: 'camera.create', camera: { id: CAMERA_ID } },
      {
        type: 'viewport.create',
        viewport: {
          id: 'v',
          cameraId: CAMERA_ID,
          mode: PANORAMA.id,
          projection: PANORAMA.projection,
          size: { width: 640, height: 360, devicePixelRatio: 1 },
        },
      },
      ...presetCommands(planPreset('seam', 1)),
    ]).status,
  ).toBe('committed');
  const modes = createModes(ws, 'v');
  modes.register(PANORAMA);
  modes.register(createFocusMode({ fill: 0.75, maxMagnification: 2.5 }));
  const frames = new Frames();
  const clock = { now: 1000 };
  const transitions: ViewTransitions = createViewTransitions({
    workspace: ws,
    viewportIds: ['v'],
    framing: (state) => {
      const mode = state.viewports.get('v')?.mode ?? PANORAMA.id;
      return { mode, framed: mode === FOCUS_ID ? state.focusedId : null };
    },
    frames,
    now: () => clock.now,
    motion: () => motion,
  });
  return { ws, modes, frames, clock, transitions };
}

/** The heading the viewport's camera shows now, previews and all, in degrees. */
function shownHeading(ws: Workspace): number {
  const rotation = ws.getPresented().cameras.get(CAMERA_ID)?.rotation;
  if (rotation === undefined) throw new Error('no camera');
  return (headingPitchOf(rotation).heading * 180) / Math.PI;
}

function committedHeading(ws: Workspace): number {
  const rotation = ws.getState().cameras.get(CAMERA_ID)?.rotation;
  if (rotation === undefined) throw new Error('no camera');
  return (headingPitchOf(rotation).heading * 180) / Math.PI;
}

function shownHorizontal(ws: Workspace): number {
  const config = ws.getPresented().viewports.get('v')?.projection.config as { horizontal: number };
  return config.horizontal;
}

describe('the view moving into a focus, between focused windows and out of it', () => {
  it('commits at once and shows the move from the first frame on, until the committed view is shown', () => {
    const { ws, modes, frames, clock, transitions } = scene();
    const start = committedHeading(ws);
    modes.switchTo(FOCUS_ID, { target: 'window-03' });
    // The truth is committed at once; what is shown starts where the view was.
    const target = committedHeading(ws);
    expect(target).not.toBeCloseTo(start, 3);
    expect(transitions.running()).toBe(true);
    expect(ws.getPreview(TRANSITION_PREVIEW)).toBeDefined();
    expect(shownHeading(ws)).toBeCloseTo(start, 9);
    expect(shownHorizontal(ws)).toBeCloseTo(360, 9);
    // However long the first frame took to come, the move starts from it.
    clock.now += 500;
    frames.run();
    expect(shownHeading(ws)).toBeCloseTo(start, 9);
    // Halfway through, the view is on its way, turned part of the way; focus keeps the panorama's
    // field of view, its card scaled instead.
    clock.now += TRANSITION_MS / 2;
    frames.run();
    const midway = shownHeading(ws);
    expect(Math.abs(midway - start)).toBeGreaterThan(0);
    expect(Math.abs(midway - target)).toBeGreaterThan(0);
    expect(Math.abs(midway - start) + Math.abs(target - midway)).toBeCloseTo(
      Math.abs(target - start),
      6,
    );
    expect(shownHorizontal(ws)).toBe(360);
    // At its end, the preview is gone and the committed view is what is shown.
    clock.now += TRANSITION_MS;
    frames.run();
    expect(transitions.running()).toBe(false);
    expect(ws.getPreview(TRANSITION_PREVIEW)).toBeUndefined();
    expect(ws.getPresented()).toBe(ws.getState());
    expect(frames.pending).toBe(0);
  });

  it('moves the panorama’s horizon evenly to where focus stands its window, never dropping it', () => {
    const { ws, modes, frames, clock } = scene();
    // Raised, the window is stood in the middle of the view by a lower horizon.
    const node = ws.getState().nodes.get('window-03');
    const [x, , z] = node?.transform.position ?? [0, 0, 0];
    expect(
      ws.dispatch({
        type: 'node.patch',
        id: 'window-03',
        transform: { ...(node?.transform ?? {}), position: [x, 1, z] },
      } as never).status,
    ).toBe('committed');
    const horizonOf = (state: ReturnType<Workspace['getState']>) =>
      (state.viewports.get('v')?.projection.config as { horizon?: number }).horizon;
    const panorama = horizonOf(ws.getState());
    modes.switchTo(FOCUS_ID, { target: 'window-03' });
    const focused = horizonOf(ws.getState());
    expect(focused).toBeGreaterThan(panorama ?? 1);
    frames.run();
    expect(horizonOf(ws.getPresented())).toBeCloseTo(panorama ?? 0, 9);
    clock.now += TRANSITION_MS / 2;
    frames.run();
    const midway = horizonOf(ws.getPresented());
    expect(midway).toBeGreaterThan(panorama ?? 1);
    expect(midway).toBeLessThan(focused ?? 0);
    clock.now += TRANSITION_MS;
    frames.run();
    expect(horizonOf(ws.getPresented())).toBe(focused);
  });

  it('moves out of a focus the same way, back to the view it came from', () => {
    const { ws, modes, frames, clock, transitions } = scene();
    const start = committedHeading(ws);
    modes.switchTo(FOCUS_ID, { target: 'window-05' });
    frames.run();
    clock.now += TRANSITION_MS;
    frames.run();
    expect(transitions.running()).toBe(false);
    const focused = committedHeading(ws);
    modes.back();
    expect(committedHeading(ws)).toBeCloseTo(start, 12);
    expect(transitions.running()).toBe(true);
    // The view moves back from where it was.
    expect(shownHeading(ws)).toBeCloseTo(focused, 9);
    frames.run();
    clock.now += TRANSITION_MS;
    frames.run();
    expect(ws.getPresented()).toBe(ws.getState());
  });

  it('goes where it is committed at once when the reader asks for less motion', () => {
    const { ws, modes, frames, transitions } = scene(false);
    modes.switchTo(FOCUS_ID, { target: 'window-03' });
    expect(transitions.running()).toBe(false);
    expect(ws.getPreview(TRANSITION_PREVIEW)).toBeUndefined();
    expect(frames.pending).toBe(0);
    expect(ws.getPresented()).toBe(ws.getState());
  });

  it('ends at once when the reader turns the camera or takes a window in hand, and goes on through a fit', () => {
    const { ws, modes, frames, clock, transitions } = scene();
    modes.switchTo(FOCUS_ID, { target: 'window-03' });
    frames.run();
    // The view resized as the focus lays itself out, and the focus fitted to it: the move goes on,
    // to the view as fitted.
    ws.dispatch(
      {
        type: 'viewport.patch',
        id: 'v',
        size: { width: 640, height: 300, devicePixelRatio: 1 },
      },
      { source: 'system' },
    );
    expect(transitions.running()).toBe(true);
    const fitted = ws.getState().viewports.get('v')?.projection;
    clock.now += TRANSITION_MS * 2;
    frames.run();
    expect(ws.getPresented().viewports.get('v')?.projection).toEqual(fitted);
    modes.switchTo(FOCUS_ID, { target: 'window-04' });
    frames.run();
    clock.now += TRANSITION_MS / 3;
    frames.run();
    // The reader turns the camera: the view is where they turned it, at once.
    ws.dispatch(
      { type: 'camera.patch', id: CAMERA_ID, rotation: [0, 0, 0, 1] },
      { source: 'user' },
    );
    expect(transitions.running()).toBe(false);
    expect(ws.getPreview(TRANSITION_PREVIEW)).toBeUndefined();
    // Another window focused starts another move; a drag's preview ends it.
    ws.transaction([{ type: 'focus.set', id: 'window-06' }], { source: 'user' });
    expect(transitions.running()).toBe(true);
    const node = ws.getState().nodes.get('window-01');
    if (node === undefined) throw new Error('no window');
    ws.preview('drag', [{ type: 'node.patch', id: 'window-01', transform: node.transform }]);
    expect(transitions.running()).toBe(false);
    expect(ws.getPreview(TRANSITION_PREVIEW)).toBeUndefined();
  });

  it('lets go of its preview when disposed', () => {
    const { ws, modes, transitions } = scene();
    modes.switchTo(FOCUS_ID, { target: 'window-03' });
    expect(ws.getPreview(TRANSITION_PREVIEW)).toBeDefined();
    transitions.dispose();
    expect(ws.getPreview(TRANSITION_PREVIEW)).toBeUndefined();
  });
});
