import { worldMatrix } from '@swf/core';
import type { Vec3 } from '@swf/math';
import { mat4TransformPoint } from '@swf/math';
import type { ViewportFrame } from '@swf/presentation';
import { viewGeometryOf } from '@swf/presentation';
import { equirectangular } from '@swf/projections';
import { afterEach, describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import type { ReferenceApp } from '../../src/app.js';
import { createReferenceApp, VIEWPORT_ID } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import type { PresetId } from '../../src/presets.js';
import { planPreset } from '../../src/presets.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
    mouse: (
      action: 'move' | 'down' | 'up',
      x: number,
      y: number,
      modifiers?: readonly string[],
    ) => Promise<void>;
  }
}

const W = 1200;
const H = 400;

let app: ReferenceApp | null = null;
let root: HTMLElement | null = null;
afterEach(async () => {
  await app?.dispose();
  root?.remove();
  app = null;
  root = null;
});

async function start(config: Partial<AppConfig> = {}): Promise<ReferenceApp> {
  root = document.createElement('div');
  root.style.setProperty('position', 'absolute');
  root.style.setProperty('left', '0');
  root.style.setProperty('top', '0');
  root.style.setProperty('width', `${String(W)}px`);
  root.style.setProperty('height', `${String(H)}px`);
  document.body.append(root);
  app = await createReferenceApp({
    root,
    config: { preset: 'sparse', seed: 1, backend: 'dom', restore: false, ...config },
  });
  return app;
}

/** Waits until every surface has settled its binding, then presents a frame. */
async function frame(a: ReferenceApp): Promise<ViewportFrame> {
  for (let i = 0; i < 50; i++) {
    if (a.runtime.list().every((s) => s.state !== 'binding')) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const update = await a.viewport.update();
  if (update.status !== 'presented') {
    throw new Error(`the viewport is degraded: ${update.error.message}`);
  }
  return update;
}

/** How each fragment of a surface was presented in a frame, left to right. */
function modesOf(f: ViewportFrame, surfaceId: string): { x: number; mode: string }[] {
  return f.frame.planned
    .filter((p) => p.fragment.surfaceId === surfaceId)
    .map((p) => ({ x: p.fragment.bounds[0], mode: p.negotiation.mode }))
    .sort((a, b) => a.x - b.x);
}

/** Where a point of a window, in its local frame, appears in the view. */
function screenOf(a: ReferenceApp, nodeId: string, local: Vec3): [number, number] {
  const state = a.workspace.getState();
  const m = worldMatrix(state.nodes, nodeId);
  if (m === undefined) {
    throw new Error(`no ${nodeId}`);
  }
  const view = viewGeometryOf(state, VIEWPORT_ID);
  const image = equirectangular
    .create(view.projectionConfig)
    .projectDirection(mat4TransformPoint(m, local), view).images[0];
  if (image === undefined) {
    throw new Error(`${nodeId} is not in view`);
  }
  return [image[0], image[1]];
}

/** A window's heading, in degrees to the right of straight ahead. */
function headingOf(a: ReferenceApp, nodeId: string): number {
  const p = a.workspace.getState().nodes.get(nodeId)?.transform.position;
  if (p === undefined) {
    throw new Error(`no ${nodeId}`);
  }
  return (Math.atan2(p[0], -p[2]) * 180) / Math.PI;
}

/** The scene's windows, as their IDs, labels, binding keys and positions. */
function windowsOf(a: ReferenceApp) {
  return [...a.workspace.getState().nodes.values()]
    .filter((n) => n.kind === 'window')
    .map((n) => ({
      id: n.id,
      label: n.label,
      key: a.workspace.getState().surfaces.get(`${n.id}-surface`)?.bindingKey,
      position: n.transform.position.map((v) => Math.round(v * 1e9) / 1e9),
    }))
    .sort((x, y) => x.id.localeCompare(y.id));
}

function plannedWindows(preset: PresetId, seed: number) {
  return planPreset(preset, seed)
    .map((w) => {
      const h = (w.heading * Math.PI) / 180;
      const e = (w.elevation * Math.PI) / 180;
      const d = w.distance;
      return {
        id: w.id,
        label: w.label,
        key: w.bindingKey,
        position: [
          d * Math.cos(e) * Math.sin(h),
          d * Math.sin(e),
          -d * Math.cos(e) * Math.cos(h),
        ].map((v) => Math.round(v * 1e9) / 1e9),
      };
    })
    .sort((x, y) => x.id.localeCompare(y.id));
}

describe('the panorama on the DOM backend (UX-002, WF-01)', () => {
  it('shows the whole 360° scene, notes live (approximately placed, as a panorama bends them) and drawn tiles as labelled proxies', async () => {
    const a = await start({ preset: 'sparse' });
    const f = await frame(a);
    expect(a.status()).toMatchObject({ backend: 'dom', mode: 'panorama', windows: 6 });
    for (const w of planPreset('sparse', 1)) {
      const modes = modesOf(f, `${w.id}-surface`);
      expect(modes.length, w.id).toBeGreaterThan(0);
      const shown = modes.map((m) => m.mode);
      if (w.content === 'note') {
        // Live in exactly one fragment: a note across the seam is a proxy on its other side.
        expect(
          shown.filter((m) => m === 'approximated'),
          w.id,
        ).toHaveLength(1);
        expect(
          shown.filter((m) => m !== 'approximated' && m !== 'proxy'),
          w.id,
        ).toEqual([]);
        expect(a.viewport.presentation(`${w.id}-surface`)).toBe('live');
      } else {
        expect(
          shown.every((m) => m === 'proxy'),
          w.id,
        ).toBe(true);
      }
    }
    // Each note's own element is in the view, as the page's own content.
    const notes = root?.querySelectorAll('[data-reference-content]') ?? [];
    expect(notes).toHaveLength(planPreset('sparse', 1).filter((w) => w.content === 'note').length);
  });

  it('shows a window across the seam on both edges, live on one side and a proxy on the other, picking as one window', async () => {
    const a = await start({ preset: 'seam' });
    const f = await frame(a);
    const modes = modesOf(f, 'window-01-surface');
    expect(modes).toHaveLength(2);
    expect(modes.map((m) => m.mode).sort()).toEqual(['approximated', 'proxy']);
    expect(modes[0]?.x).toBeLessThan(1);
    expect(modes[1]?.x).toBeGreaterThan(W / 2);
    for (const x of [4, 30, W - 30, W - 4]) {
      const hit = a.router.pick(VIEWPORT_ID, x, H / 2);
      expect(hit.kind === 'hit' && hit.target.surfaceId, `at ${String(x)}`).toBe(
        'window-01-surface',
      );
    }
  });

  it('drags a window across the seam as one target, with no jump, committing once', async () => {
    const a = await start({ preset: 'seam' });
    await frame(a);
    const gestures: string[] = [];
    a.router.subscribe((event) => {
      if (event.type === 'gesture.started') {
        gestures.push(`start ${event.operation} ${event.nodeId ?? ''}`);
      } else if (event.type === 'gesture.ended') {
        gestures.push(`end ${event.finish.outcome}`);
      }
    });
    const revision = a.workspace.getState().revision;
    // The window's content left of the seam (the right edge), taken with the takeover modifier.
    const [x, y] = screenOf(a, 'window-01', [-0.7, 0, 0]);
    expect(x).toBeGreaterThan(W - 120);
    const headings: number[] = [];
    const unwatch = a.workspace.subscribe((event) => {
      if (event.type === 'transform.preview') {
        const preview = a.workspace.getPreview(event.payload.previewId)?.nodes.get('window-01')
          ?.transform.position;
        if (preview !== undefined) {
          headings.push((Math.atan2(preview[0], -preview[2]) * 180) / Math.PI);
        }
      }
    });
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y, ['Alt']);
    let steps = 0;
    for (let px = x + 4; px <= W - 4; px += 4) {
      steps += 1;
      await commands.mouse('move', px, y);
      // Previews are announced once per animation frame: let each move have its own.
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await commands.mouse('up', W - 4, y);
    unwatch();
    expect(gestures).toEqual(['start node.move window-01', 'end committed']);
    expect(a.workspace.getState().revision).toBe(revision + 1);
    // The drag previewed the window at every step on the way but the first, which is within the
    // pointer's slop and only starts the drag.
    expect(steps).toBeGreaterThan(8);
    expect(headings.length).toBeGreaterThanOrEqual(steps - 1);
    // The window crossed the seam: from 180° to the other side, moving steadily right.
    const after = headingOf(a, 'window-01');
    expect(after).toBeGreaterThan(-178);
    expect(after).toBeLessThan(-160);
    const unwrapped = [...headings, after].map((h) => (h < 0 ? h + 360 : h));
    for (let i = 1; i < unwrapped.length; i++) {
      const step = (unwrapped[i] ?? 0) - (unwrapped[i - 1] ?? 0);
      expect(step).toBeGreaterThanOrEqual(-0.01);
      expect(step).toBeLessThan(3);
    }
    // One undo puts it back exactly.
    expect(a.workspace.undo().status).toBe('committed');
    expect(headingOf(a, 'window-01')).toBeCloseTo(180, 9);
  });
});

describe('the panorama on the geometry backend', () => {
  it('draws tiles warped into the panorama while notes stay live, the same elements as before', async () => {
    const a = await start({ preset: 'seam' });
    await frame(a);
    const before = new Set(root?.querySelectorAll('[data-reference-content]'));
    expect(before.size).toBeGreaterThan(0);
    expect((await a.switchBackend('geometry')).status).toBe('switched');
    const f = await frame(a);
    expect(a.status().backend).toBe('geometry');
    expect(root?.querySelectorAll('canvas').length).toBeGreaterThan(0);
    for (const w of planPreset('seam', 1)) {
      const modes = modesOf(f, `${w.id}-surface`).map((m) => m.mode);
      if (w.content === 'tile') {
        expect(modes.length, w.id).toBeGreaterThan(0);
        expect(modes.includes('proxy'), w.id).toBe(false);
      }
    }
    // The seam window still has one live side and one proxy, and picks as one window.
    expect(
      modesOf(f, 'window-01-surface')
        .map((m) => m.mode)
        .sort(),
    ).toEqual(['approximated', 'proxy']);
    const left = a.router.pick(VIEWPORT_ID, 4, H / 2);
    const right = a.router.pick(VIEWPORT_ID, W - 4, H / 2);
    expect(left.kind === 'hit' && left.target.surfaceId).toBe('window-01-surface');
    expect(right.kind === 'hit' && right.target.surfaceId).toBe('window-01-surface');
    // Live content was handed over, never made again.
    const now = new Set(root?.querySelectorAll('[data-reference-content]'));
    expect(now).toEqual(before);
  });

  it('starts on the geometry backend when configured, and switches back to the DOM', async () => {
    const a = await start({ preset: 'sparse', backend: 'geometry' });
    await frame(a);
    expect(a.status().backend).toBe('geometry');
    const outcome = await a.commands.run('reference.backend.switch', { backend: 'dom' });
    expect(outcome).toEqual({ status: 'done' });
    await frame(a);
    expect(a.status().backend).toBe('dom');
  });
});

describe('presets with reset and reseed (FR-012, FR-131, MIG-005)', () => {
  it('loads each preset exactly as planned, and resets it after windows have moved', async () => {
    const a = await start({ preset: 'sparse', seed: 1 });
    expect(windowsOf(a)).toEqual(plannedWindows('sparse', 1));
    expect(
      a.workspace.dispatch({
        type: 'node.patch',
        id: 'window-02',
        transform: { position: [0, 2, -1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      }).status,
    ).toBe('committed');
    expect(a.workspace.dispatch({ type: 'selection.set', ids: ['window-03'] }).status).toBe(
      'committed',
    );
    expect(windowsOf(a)).not.toEqual(plannedWindows('sparse', 1));
    expect(await a.commands.run('reference.scene.reset', {})).toEqual({ status: 'done' });
    expect(windowsOf(a)).toEqual(plannedWindows('sparse', 1));
    expect(a.workspace.getState().selection).toEqual([]);
    expect(a.status().scene).toEqual({ preset: 'sparse', seed: 1 });
  });

  it('reseeds to the next seed or a given one, and the same seed gives the same scene again', async () => {
    const a = await start({ preset: 'seam', seed: 1 });
    expect(await a.commands.run('reference.scene.reseed', {})).toEqual({ status: 'done' });
    expect(a.status().scene).toEqual({ preset: 'seam', seed: 2 });
    expect(windowsOf(a)).toEqual(plannedWindows('seam', 2));
    expect(await a.commands.run('reference.scene.reseed', { seed: 7 })).toEqual({
      status: 'done',
    });
    expect(windowsOf(a)).toEqual(plannedWindows('seam', 7));
    expect(await a.commands.run('reference.scene.reseed', { seed: 1 })).toEqual({
      status: 'done',
    });
    expect(windowsOf(a)).toEqual(plannedWindows('seam', 1));
    expect(await a.commands.run('reference.scene.reseed', { seed: -3 })).toMatchObject({
      status: 'rejected',
      field: 'seed',
    });
    expect(a.status().scene).toEqual({ preset: 'seam', seed: 1 });
  });

  it('switches between the presets, the dense one at the benchmark’s 250 windows', async () => {
    const a = await start({ preset: 'sparse' });
    expect(await a.commands.run('reference.preset.load', { preset: 'dense' })).toEqual({
      status: 'done',
    });
    expect(a.status()).toMatchObject({ scene: { preset: 'dense', seed: 1 }, windows: 250 });
    expect(windowsOf(a)).toEqual(plannedWindows('dense', 1));
    await frame(a);
    expect(await a.commands.run('reference.preset.load', { preset: 'empty' })).toEqual({
      status: 'done',
    });
    expect(a.status().windows).toBe(0);
    // Nothing is left but the workspace group, empty, still the orbit root.
    expect([...a.workspace.getState().nodes.values()].map((n) => [n.id, n.childIds])).toEqual([
      ['workspace', []],
    ]);
    expect(a.workspace.getState().orbitRootId).toBe('workspace');
    await frame(a);
    expect(root?.querySelectorAll('[data-reference-content]')).toHaveLength(0);
  });

  it('undoes a reseed in one step, the earlier windows binding their content again', async () => {
    const a = await start({ preset: 'sparse', seed: 1 });
    await frame(a);
    expect(a.reseed().status).toBe('committed');
    await frame(a);
    expect(a.workspace.undo().status).toBe('committed');
    expect(windowsOf(a)).toEqual(plannedWindows('sparse', 1));
    await frame(a);
    for (const surface of a.runtime.list()) {
      expect(surface.state, surface.surfaceId).not.toBe('unbound');
      expect(surface.state, surface.surfaceId).not.toBe('error');
    }
  });
});
