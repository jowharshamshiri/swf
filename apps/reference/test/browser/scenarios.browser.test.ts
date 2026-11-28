import { worldMatrix } from '@swf/core';
import type { Vec3 } from '@swf/math';
import { mat4TransformPoint } from '@swf/math';
import { createMemoryStore } from '@swf/persistence';
import { viewGeometryOf } from '@swf/presentation';
import { cameraRotation, equirectangular } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import type { ReferenceApp } from '../../src/app.js';
import { VIEWPORT_ID, roomMapView, toMap } from '@swf/navigation';
import { NOTE_ADAPTER, planPreset, WORKSPACE_GROUP_ID } from '../../src/presets.js';
import type { ShellModel } from '../../src/shell/model.svelte.js';
import { endVisits, layout, same, start } from './shell-harness.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
    mouse: (
      action: 'move' | 'down' | 'up' | 'double' | 'release',
      x: number,
      y: number,
      modifiers?: readonly string[],
    ) => Promise<void>;
  }
}

function appOf(model: ShellModel): ReferenceApp {
  const app = model.app;
  if (app === null) {
    throw new Error('no application');
  }
  return app;
}

/** Where a point of a window, in its local frame, shows on the page; null when not in view. */
function pageOf(app: ReferenceApp, nodeId: string, local: Vec3): [number, number] | null {
  const state = app.workspace.getState();
  const m = worldMatrix(state.nodes, nodeId);
  if (m === undefined) {
    throw new Error(`no ${nodeId}`);
  }
  const view = viewGeometryOf(state, VIEWPORT_ID);
  const image = equirectangular
    .create(view.projectionConfig)
    .projectDirection(mat4TransformPoint(m, local), view).images[0];
  if (image === undefined) {
    return null;
  }
  const box = app.root.getBoundingClientRect();
  return [box.left + image[0], box.top + image[1]];
}

/** A window's heading, in degrees to the right of straight ahead. */
function headingOf(app: ReferenceApp, nodeId: string): number {
  const m = worldMatrix(app.workspace.getState().nodes, nodeId);
  if (m === undefined) {
    throw new Error(`no ${nodeId}`);
  }
  return (Math.atan2(m[12], -m[14]) * 180) / Math.PI;
}

/** Presses the real mouse at a page point, moves it in steps by (dx, dy) and releases it. */
async function drag(from: readonly [number, number], dx: number, dy = 0): Promise<void> {
  const [x, y] = from;
  await commands.mouse('move', x, y);
  await commands.mouse('down', x, y);
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    await commands.mouse('move', x + (dx * i) / steps, y + (dy * i) / steps);
  }
  await commands.mouse('up', x + dx, y + dy);
}

/**
 * The window the host attaches in scenario 1: a note two units from the camera, under a title band
 * tall enough to grab in the shell's panorama.
 */
const NOTE = Object.freeze({
  id: 'notes',
  width: 2,
  height: 1.6,
  distance: 2,
  surface: [1.8, 0.9] as const,
  /** The surface's centre below the window's, leaving the band above it. */
  surfaceY: -0.27,
  /** A point of the title band, below the window's top edge and its resize handles. */
  titleY: 0.5,
});

describe('a blank workspace, end to end (§33.2 scenario 1, WF-01, AC-001, AC-009)', () => {
  it('attaches an opaque surface, interacts with it, moves it behind the camera, reveals it by panning and on the map, saves, reloads and recovers every world coordinate', async () => {
    const store = createMemoryStore();
    const { model, driver, settle, root } = await start('?preset=empty', {
      store,
      autosaveDelayMs: 0,
    });
    const app = appOf(model);
    expect(app.status().windows).toBe(0);

    // The host attaches an opaque surface: a window holding a note it knows by key.
    const key = planPreset('sparse', 1).find((w) => w.content === 'note')?.bindingKey ?? '';
    const attached = app.workspace.transaction(
      [
        {
          type: 'node.create',
          node: {
            id: NOTE.id,
            kind: 'window',
            parentId: WORKSPACE_GROUP_ID,
            label: 'Notes',
            bounds: [NOTE.width, NOTE.height, 0.01],
            transform: {
              position: [0, 0, -NOTE.distance],
              rotation: cameraRotation(0, 0),
              scale: [1, 1, 1],
            },
          },
        },
        {
          type: 'surface.attach',
          surface: {
            id: `${NOTE.id}-surface`,
            ownerNodeId: NOTE.id,
            bindingKey: key,
            adapterTypeId: NOTE_ADAPTER,
            bounds: [NOTE.surface[0], NOTE.surface[1], 0.01],
            transform: {
              position: [0, NOTE.surfaceY, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          },
        },
      ],
      { source: 'user' },
    );
    expect(attached.status).toBe('committed');

    // Mounted: the host's own element, live in the panorama.
    await expect.poll(() => app.runtime.get(`${NOTE.id}-surface`)?.state).toBe('presented');
    const content = root.querySelector<HTMLElement>(`[data-reference-content="${key}"]`);
    expect(content?.isConnected).toBe(true);

    // Interacted with natively: a real press and real typing reach the content, and the scene
    // changes only by the window pressed becoming the one worked on.
    const revision = app.workspace.getState().revision;
    const text = content?.querySelector('p');
    const box = text?.getBoundingClientRect();
    if (text === null || text === undefined || box === undefined) {
      throw new Error('the note has no text');
    }
    await commands.mouse('move', box.left + box.width / 2, box.top + box.height / 2);
    await commands.mouse('down', box.left + box.width / 2, box.top + box.height / 2);
    await commands.mouse('up', box.left + box.width / 2, box.top + box.height / 2);
    await userEvent.keyboard('Hello');
    expect(text.textContent).toContain('Hello');
    expect(app.workspace.getState().revision).toBe(revision + 1);
    expect(app.workspace.getState().selection).toEqual([
      app.workspace
        .getState()
        .surfaces.get(
          [...app.workspace.getState().surfaces.values()].find((x) => x.bindingKey === key)?.id ??
            '',
        )?.ownerNodeId,
    ]);

    // Moved behind the camera on the map: its marker dragged from in front of the camera's marker
    // to behind it, one change; the window turns to keep facing the camera.
    driver.act('editor.actions.mode#map', 'press');
    await settle();
    const onMap = (x: number, z: number): [number, number] => {
      const surface = driver.read('page.map.surface');
      if (!surface.present) {
        throw new Error('no map');
      }
      const [mx, my] = toMap(roomMapView(surface.box.width, surface.box.height), x, z);
      return [surface.box.x + mx, surface.box.y + my];
    };
    const history = app.workspace.history().length;
    const [fx, fy] = onMap(0, -NOTE.distance);
    const [tx, ty] = onMap(0, NOTE.distance);
    await drag([fx, fy], tx - fx, ty - fy);
    await settle();
    expect(Math.abs(headingOf(app, NOTE.id))).toBeGreaterThan(175);
    expect(app.workspace.history().length).toBe(history + 1);
    const behind = layout(model);
    driver.act('editor.actions.mode#panorama', 'press');
    await settle();
    expect(app.status().mode).toBe('panorama');
    const width = app.root.getBoundingClientRect().width;

    // Revealed by panning: the background dragged half round turns the camera to face it.
    const [bx, by] = [
      app.root.getBoundingClientRect().left + 40,
      app.root.getBoundingClientRect().top + 40,
    ];
    await drag([bx, by], width / 2 - 4);
    await settle();
    const centre = pageOf(app, NOTE.id, [0, 0, 0]);
    const rootBox = app.root.getBoundingClientRect();
    expect(centre?.[0]).toBeCloseTo(rootBox.left + rootBox.width / 2, -2);
    // Panning turned the view, never the window.
    expect(layout(model)).toEqual(behind);

    // Revealed on the map: panned back to straight ahead, it is behind the camera again; pressed
    // on the map, it is revealed from the windows list. Panned from the right, the drag stays in
    // the view (one reaching its edge would lock the pointer, which automation cannot move).
    await drag([rootBox.right - 40, by], -(width / 2 - 4));
    await settle();
    expect(pageOf(app, NOTE.id, [0, 0, 0])?.[0]).not.toBeCloseTo(
      rootBox.left + rootBox.width / 2,
      -2,
    );
    driver.act('editor.actions.mode#map', 'press');
    await settle();
    expect(driver.read(`page.map.unit#${NOTE.id}`).present).toBe(true);
    const m = worldMatrix(app.workspace.getState().nodes, NOTE.id);
    const [px, py] = onMap(m?.[12] ?? 0, m?.[14] ?? 0);
    await commands.mouse('move', px, py);
    await commands.mouse('down', px, py);
    await commands.mouse('up', px, py);
    await settle();
    expect(app.workspace.getState().selection).toEqual([NOTE.id]);
    expect(layout(model)).toEqual(behind);
    driver.act('workshop.view#windows', 'press');
    await settle();
    driver.act(`page.windows.row.reveal#${NOTE.id}`, 'press');
    await settle();
    expect(app.status().mode).toBe('panorama');
    const revealed = pageOf(app, NOTE.id, [0, 0, 0]);
    expect(revealed?.[0]).toBeCloseTo(rootBox.left + rootBox.width / 2, -2);
    expect(layout(model)).toEqual(behind);

    // Saved, reloaded in a new visit, bound again, and every world coordinate recovered.
    expect(await model.saveAs('Scenario one')).toBe(true);
    await expect.poll(() => model.workspaces?.save).toBe('clean');
    const saved = layout(model);
    await endVisits();
    const next = await start('', { store, autosaveDelayMs: 0 });
    const reloaded = appOf(next.model);
    await expect.poll(() => reloaded.runtime.get(`${NOTE.id}-surface`)?.state).toBe('presented');
    const restored = layout(next.model);
    expect(restored.nodes.map((n) => [n.id, n.parentId])).toEqual(
      saved.nodes.map((n) => [n.id, n.parentId]),
    );
    for (const [i, n] of saved.nodes.entries()) {
      expect(same(restored.nodes[i]?.world, n.world), n.id).toBe(true);
    }
    for (const [i, s] of saved.surfaces.entries()) {
      expect(restored.surfaces[i]?.owner, s.id).toBe(s.owner);
      expect(same(restored.surfaces[i]?.world, s.world), s.id).toBe(true);
    }
    expect(reloaded.workspace.getState().surfaces.get(`${NOTE.id}-surface`)?.bindingKey).toBe(key);
  });
});

describe('losing the renderer in an active scene (§33.2 scenario 6, NFR-013, §27)', () => {
  it('falls back, then says the backend is unavailable while commands still work, restores and takes real input again, the layout kept', async () => {
    const { model, driver, settle, root } = await start('?preset=sparse', {
      store: createMemoryStore(),
    });
    const app = appOf(model);
    const before = app.workspace.serialize();
    driver.act('worktree.view#developer', 'press');
    await settle();
    driver.act('page.developer.section#simulate', 'press');
    await settle();
    // The DOM renderer goes: the viewport falls back to the other backend, visibly so.
    driver.act('page.developer.renderer.remove#dom', 'press');
    await expect.poll(() => model.status?.backend).toBe('geometry');
    expect(app.workspace.serialize()).toEqual(before);
    // Then the other: nothing can present, and the view says so.
    driver.act('page.developer.renderer.remove#geometry', 'press');
    await expect.poll(() => model.status?.backend).toBeNull();
    await expect
      .poll(() => root.querySelector('[data-swf-degraded]')?.textContent ?? '')
      .toMatch(/^Backend unavailable/);
    expect(app.workspace.serialize()).toEqual(before);
    // Commands and transactions still work while nothing presents (NFR-013).
    expect(await model.run('swf.window.place', { id: 'window-02', y: 0.4 })).toBe(true);
    const placed = app.workspace.serialize();
    expect(worldMatrix(app.workspace.getState().nodes, 'window-02')?.[13]).toBeCloseTo(0.4, 9);
    // A compatible backend back: presented again, with the layout as it was left.
    driver.act('page.developer.renderer.restore#dom', 'press');
    await expect.poll(() => model.status?.backend).toBe('dom');
    driver.act('page.developer.renderer.restore#geometry', 'press');
    await settle();
    expect(root.querySelector('[data-swf-degraded]')).toBeNull();
    expect(app.workspace.serialize()).toEqual(placed);
    const frame = await app.viewport.update();
    expect(frame.status).toBe('presented');
    // And real input reaches the scene again: a press on a window's title selects it.
    const window = app.workspace.getState().nodes.get('window-03');
    const title = pageOf(app, 'window-03', [0, (window?.bounds[1] ?? 0) / 2 - 0.1, 0]);
    if (title === null) {
      throw new Error('window-03 is not in view');
    }
    await commands.mouse('move', ...title);
    await commands.mouse('down', ...title);
    await commands.mouse('up', ...title);
    await settle();
    expect(app.workspace.getState().selection).toEqual(['window-03']);
    expect(app.workspace.serialize().nodes).toEqual(placed.nodes);
  });
});

describe('snapshots that cannot be loaded (§33.2 scenario 8, QA-007, FR-201)', () => {
  it('refuses a corrupted, an oversized and a cyclic snapshot, saying what is wrong and where, the workspace unchanged', async () => {
    const source = await start('?preset=seam', { store: createMemoryStore() });
    const good = await appOf(source.model).workspaces.exportText();
    await endVisits();
    const { model, driver, settle, root } = await start('?preset=sparse', {
      store: createMemoryStore(),
    });
    driver.act('workshop.view#workspaces', 'press');
    await settle();
    const app = appOf(model);
    const before = app.workspace.serialize();
    const revision = app.workspace.getState().revision;
    const document = JSON.parse(good) as {
      rootIds: string[];
      nodes: { id: string; parentId: string | null; childIds: string[] }[];
    };
    // Two windows each made the other's parent.
    const [a, b] = document.nodes.filter((n) => n.childIds.length === 0);
    if (a === undefined || b === undefined) {
      throw new Error('the snapshot has too few windows');
    }
    const cyclic = JSON.parse(good) as typeof document;
    const at = (id: string) => cyclic.nodes.findIndex((n) => n.id === id);
    const [ia, ib] = [at(a.id), at(b.id)];
    for (const n of cyclic.nodes) {
      n.childIds = n.childIds.filter((id) => id !== a.id && id !== b.id);
    }
    cyclic.rootIds = cyclic.rootIds.filter((id) => id !== a.id && id !== b.id);
    Object.assign(cyclic.nodes[ia] ?? {}, { parentId: b.id, childIds: [b.id] });
    Object.assign(cyclic.nodes[ib] ?? {}, { parentId: a.id, childIds: [a.id] });
    const cases: [string, string, RegExp][] = [
      ['corrupted.json', good.slice(0, Math.floor(good.length / 2)), /at line \d+, column \d+/],
      [
        'oversized.json',
        `${good.slice(0, -2)}, "pad": "${'x'.repeat(33 * 1024 * 1024)}"}`,
        /over the limit of 33554432/,
      ],
      [
        'cyclic.json',
        JSON.stringify(cyclic),
        new RegExp(`nodes\\[${String(Math.min(ia, ib))}\\]\\.parentId|cycle`),
      ],
    ];
    for (const [name, text, reason] of cases) {
      model.beginImport(name, text);
      await settle();
      // Nothing to confirm: the file is refused at once, saying why and where.
      expect(driver.has('page.replace'), name).toBe(false);
      const note = root.querySelector('[data-wsb="page.workspaces.note"]')?.textContent ?? '';
      expect(note, name).toContain('This file cannot be imported');
      expect(note, name).toMatch(reason);
      expect(note, name).toContain('Nothing was changed.');
      expect(app.workspace.serialize(), name).toEqual(before);
      expect(app.workspace.getState().revision, name).toBe(revision);
    }
  });
});
