import { keyed } from '@wsb/uikit/handles';
import { createMemoryStore } from '@swf/persistence';
import { describe, expect, it } from 'vitest';
import type { ReferenceApp } from '../../src/app.js';
import { VIEWPORT_ID } from '../../src/app.js';
import { FOCUS_ID } from '../../src/focus.js';
import { cameraHeading } from '../../src/orbit.js';
import { wrapDegrees } from '../../src/pose.js';
import type { ScenarioId } from '../../src/scenarios.js';
import { SCENARIO_LAYOUT } from '../../src/scenarios.js';
import type { ShellModel } from '../../src/shell/model.svelte.js';
import type { Mounted } from './shell-harness.js';
import { start } from './shell-harness.js';

/**
 * The guided scenarios and the timed task, driven as an operator drives them: every scenario
 * started from the Scenarios view, each step done through the application's own controls (the
 * panorama's view modes, the command list, the inspector, the Workspaces view, the keyboard, or the
 * step's Show me), and ticked off in the view as it is done.
 */

function appOf(model: ShellModel): ReferenceApp {
  const app = model.app;
  if (app === null) {
    throw new Error('no application');
  }
  return app;
}

/** What the scenario under way says in the view. */
const said = (m: Mounted) => {
  const reading = m.driver.read('page.scenarios.current');
  return reading.present ? reading.text : '';
};

/** Waits until the view says a step is due, or that every step is done. */
async function due(m: Mounted, step: number | 'finished'): Promise<void> {
  await m.settle();
  await expect
    .poll(() => said(m), { timeout: 5000 })
    .toContain(step === 'finished' ? 'Every step is done.' : `Step ${String(step)} of 3`);
}

/** Opens the Scenarios view and starts a scenario from its list, from another scene. */
async function begin(id: ScenarioId): Promise<Mounted> {
  const m = await start('?preset=sparse', { store: createMemoryStore(), autosaveDelayMs: 0 });
  m.driver.act('workshop.view#scenarios', 'press');
  await m.settle();
  m.driver.act(keyed('page.scenarios.start', id), 'press');
  await due(m, 1);
  // It starts from the studio, in the panorama.
  expect(m.model.status?.scene.preset).toBe('studio');
  expect(m.model.status?.mode).toBe('panorama');
  return m;
}

/** Presses the step due's Show me. */
async function showMe(m: Mounted): Promise<void> {
  m.driver.act('page.scenarios.show', 'press');
  await m.settle();
}

/** Picks a window by name in the command list: it is selected and the camera turns to it. */
async function goTo(m: Mounted, name: string, id: string): Promise<void> {
  m.driver.act('editor.actions.commands', 'press');
  await m.settle();
  m.driver.act('application.palette.field', 'type', name);
  await m.settle();
  m.driver.act(`application.palette.list#window.${id}`, 'press');
  await m.settle();
}

/** How far round a window is from where the camera faces, in degrees. */
function offCamera(app: ReferenceApp, id: string): number {
  const pose = app.poseOf(id);
  const heading = (cameraHeading(app.workspace.getState(), VIEWPORT_ID) * 180) / Math.PI;
  return Math.abs(wrapDegrees((pose?.heading ?? NaN) - heading));
}

describe('the guided scenarios, driven from the Scenarios view', () => {
  it('lists every scenario and replaces the scene only as one undoable step', async () => {
    const m = await begin('behind');
    const nodes = () => [...appOf(m.model).workspace.getState().nodes.values()].map((n) => n.id);
    expect(nodes()).toContain('desk');
    // Undo brings back the windows of the scene the scenario replaced.
    m.driver.act('editor.actions.undo', 'press');
    await m.settle();
    expect(nodes()).toContain('window-01');
    expect(nodes()).not.toContain('desk');
    m.driver.act('page.scenarios.stop', 'press');
    await m.settle();
    for (const id of ['behind', 'hidden', 'depth', 'focus', 'compose', 'restore']) {
      expect(m.driver.has(keyed('page.scenarios.start', id)), id).toBe(true);
    }
  });

  it('puts a window behind the camera, and finds it there on the map', async () => {
    const m = await begin('behind');
    const app = appOf(m.model);
    expect(offCamera(app, 'desk')).toBeLessThan(90);
    await goTo(m, 'Writing Desk', 'desk');
    await due(m, 2);
    // Behind the camera, by its exact place in the inspector: across the camera from where it was.
    const [x, , z] = app.poseOf('desk')?.position ?? [NaN, NaN, NaN];
    m.driver.act('page.inspector.exact#x', 'set', String(-x));
    m.driver.act('page.inspector.exact#z', 'set', String(-z));
    await m.settle();
    m.driver.act('page.inspector.exact.apply', 'press');
    await due(m, 3);
    expect(offCamera(app, 'desk')).toBeGreaterThan(90);
    m.driver.act('editor.actions.mode#map', 'press');
    await due(m, 'finished');
    expect(m.model.status?.mode).toBe('map');
  });

  it('reaches a window behind the camera without turning round, faces it and reads it', async () => {
    const m = await begin('hidden');
    const app = appOf(m.model);
    expect(offCamera(app, 'tasks')).toBeGreaterThan(90);
    // Going to it by name both selects it and turns to it: two steps at once.
    await goTo(m, 'Tasks', 'tasks');
    await due(m, 3);
    expect(offCamera(app, 'tasks')).toBeLessThan(30);
    m.driver.act('editor.actions.mode#focus', 'press');
    await due(m, 'finished');
    expect(m.model.status?.mode).toBe(FOCUS_ID);
    expect(app.workspace.getState().focusedId).toBe('tasks');
  });

  it('brings a far window near, where its content shows, and pushes it back to its label', async () => {
    const m = await begin('depth');
    const app = appOf(m.model);
    await showMe(m);
    await due(m, 2);
    expect(m.model.selected?.id).toBe('media');
    await expect.poll(() => app.policies.representationOf('media')).toBe('label');
    await showMe(m);
    await due(m, 3);
    expect(app.poseOf('media')?.distance).toBeLessThan(4);
    await expect.poll(() => app.policies.representationOf('media')).toBe('full');
    // The note's own content is on the page now that it is near.
    await expect.poll(() => m.root.textContent).toContain('A transcript with annotations');
    await showMe(m);
    await due(m, 'finished');
    expect(app.poseOf('media')?.distance).toBeGreaterThanOrEqual(5.5);
    await expect.poll(() => app.policies.representationOf('media')).toBe('label');
  });

  it('focuses a window, moves to a neighbour, and leaves focus with Escape', async () => {
    const m = await begin('focus');
    const app = appOf(m.model);
    await showMe(m);
    await due(m, 2);
    expect(m.model.status?.mode).toBe(FOCUS_ID);
    const first = app.workspace.getState().focusedId;
    await showMe(m);
    await due(m, 3);
    expect(app.workspace.getState().focusedId).not.toBe(first);
    m.driver.act('page.panorama', 'key', 'Escape');
    await due(m, 'finished');
    expect(m.model.status?.mode).toBe('panorama');
  });

  it('detaches a surface from the board in the inspector, moves it into another window and back', async () => {
    const m = await begin('compose');
    const app = appOf(m.model);
    const owner = () => app.workspace.getState().surfaces.get('sources-surface')?.ownerNodeId;
    await goTo(m, 'Project Board', 'board');
    m.driver.act('page.inspector.detach#sources-surface', 'press');
    await due(m, 2);
    expect(owner()).not.toBe('board');
    await showMe(m);
    await due(m, 3);
    expect(owner()).toBe('desk');
    await showMe(m);
    await due(m, 'finished');
    expect(owner()).toBe('board');
  });

  it('saves the layout under a name, changes it, and opens the saved layout to put it back', async () => {
    const m = await begin('restore');
    const app = appOf(m.model);
    m.driver.act('workshop.view#workspaces', 'press');
    await m.settle();
    m.driver.act('page.workspaces.name', 'set', SCENARIO_LAYOUT);
    await m.settle();
    m.driver.act('page.workspaces.save', 'press');
    await m.settle();
    m.driver.act('workshop.view#scenarios', 'press');
    await due(m, 2);
    const saved = app.poseOf('builds')?.position;
    await showMe(m);
    await due(m, 3);
    expect(app.poseOf('builds')?.position).not.toEqual(saved);
    // Show me asks to open it; confirming replaces the workspace with what was saved.
    await showMe(m);
    expect(m.driver.has('page.replace')).toBe(true);
    m.driver.act('page.replace.confirm', 'press');
    await due(m, 'finished');
    const back = app.poseOf('builds')?.position ?? [];
    (saved ?? []).forEach((v, i) => {
      expect(back[i]).toBeCloseTo(v, 9);
    });
  });
});

describe('the timed window-finding task, driven from the Scenarios view', () => {
  it('names a window behind the camera, counts presses until it is selected, and records each way', async () => {
    const m = await start('', { store: createMemoryStore(), autosaveDelayMs: 0 });
    const app = appOf(m.model);
    expect(m.model.status?.scene.preset).toBe('studio');
    m.driver.act('workshop.view#scenarios', 'press');
    await m.settle();

    // By the map: the task shows it, names a window behind the camera, and it is pressed there.
    m.driver.act('page.challenge.method', 'choose', 'map');
    m.driver.act('page.challenge.start', 'press');
    await m.settle();
    expect(m.model.status?.mode).toBe('map');
    const run = m.model.challenge?.run;
    if (run == null) {
      throw new Error('no run started');
    }
    expect(offCamera(app, run.target)).toBeGreaterThan(90);
    expect(
      m.driver.read('page.challenge').present && m.driver.read('page.challenge'),
    ).toMatchObject({
      text: expect.stringContaining(run.label) as unknown,
    });
    m.driver.act('editor.actions.commands', 'press');
    await m.settle();
    m.driver.act('application.palette.field', 'type', run.label);
    await m.settle();
    m.driver.act(`application.palette.list#window.${run.target}`, 'press');
    await m.settle();
    await expect.poll(() => m.model.challenge?.records.length).toBe(1);
    const record = m.model.challenge?.records[0];
    expect(record).toMatchObject({ target: run.target, method: 'map' });
    expect(record?.ms).toBeGreaterThan(0);
    // The press that opened the command list, and the press that picked the window.
    expect(record?.actions).toBeGreaterThanOrEqual(2);
    expect(m.driver.read('page.challenge.found').present).toBe(true);

    // By searching: another run, then given up; then one finished.
    m.driver.act('page.challenge.method', 'choose', 'search');
    m.driver.act('page.challenge.start', 'press');
    await m.settle();
    expect(m.model.status?.mode).toBe('panorama');
    m.driver.act('page.challenge.cancel', 'press');
    await m.settle();
    expect(m.model.challenge?.run).toBeNull();
    expect(m.model.challenge?.records).toHaveLength(1);
    m.driver.act('page.challenge.start', 'press');
    await m.settle();
    const second = m.model.challenge?.run;
    if (second == null) {
      throw new Error('no second run started');
    }
    await goTo(m, second.label, second.target);
    await expect.poll(() => m.model.challenge?.records.length).toBe(2);
    expect(m.model.challenge?.records.map((r) => r.method)).toEqual(['map', 'search']);
    // The runs, and each way's summary, are on screen.
    const panel = m.driver.read('page.challenge');
    expect(panel.present && panel.text).toContain('The map');
    expect(panel.present && panel.text).toContain('Searching by name');

    m.driver.act('page.challenge.clear', 'press');
    await m.settle();
    expect(m.model.challenge?.records).toEqual([]);
  });

  it('ends a run unfinished when its window is removed, saying so', async () => {
    const m = await start('', { store: createMemoryStore(), autosaveDelayMs: 0 });
    m.driver.act('workshop.view#scenarios', 'press');
    await m.settle();
    m.driver.act('page.challenge.start', 'press');
    await m.settle();
    const run = m.model.challenge?.run;
    if (run == null) {
      throw new Error('no run started');
    }
    await m.model.removeWindow(run.target);
    await m.settle();
    expect(m.model.challenge?.run).toBeNull();
    expect(m.driver.has('page.challenge.removed')).toBe(true);
  });
});

describe('adding a window from the controls', () => {
  it('adds a blank note straight ahead of the camera, selected, as one undoable change', async () => {
    const m = await start('', { store: createMemoryStore(), autosaveDelayMs: 0 });
    const app = appOf(m.model);
    m.driver.act('workshop.view#windows', 'press');
    await m.settle();
    // Turn round first: the window comes where the camera now faces.
    await goTo(m, 'Reading List', 'reading');
    m.driver.act('page.windows.add', 'press');
    await m.settle();
    expect(m.model.status?.windows).toBe(14);
    const id = m.model.selected?.id ?? '';
    expect(id).toBe('new-window-1');
    expect(m.model.selected?.label).toBe('New window 1');
    expect(offCamera(app, id)).toBeLessThan(1e-6);
    expect(app.poseOf(id)?.distance).toBeCloseTo(3, 9);
    expect(app.poseOf(id)?.turned).toBeCloseTo(0, 9);
    // Its content is a live note, there to type in.
    await expect
      .poll(() => m.root.querySelector('[data-reference-content="added/note/1"]') !== null)
      .toBe(true);
    // A second has a number, and a colour, of its own.
    m.driver.act('page.windows.add', 'press');
    await m.settle();
    expect(m.model.selected?.id).toBe('new-window-2');
    m.driver.act('editor.actions.undo', 'press');
    await m.settle();
    expect(m.model.status?.windows).toBe(14);
    m.driver.act('editor.actions.undo', 'press');
    await m.settle();
    expect(m.model.status?.windows).toBe(13);
  });

  it('adds it ahead of the camera in a workspace that is turned round it', async () => {
    const m = await start('', { store: createMemoryStore(), autosaveDelayMs: 0 });
    const app = appOf(m.model);
    expect(await m.model.run('reference.orbit.turn', { degrees: 75 })).toBe(true);
    m.driver.act('workshop.view#windows', 'press');
    await m.settle();
    m.driver.act('page.windows.add', 'press');
    await m.settle();
    const id = m.model.selected?.id ?? '';
    expect(offCamera(app, id)).toBeLessThan(1e-6);
    expect(app.poseOf(id)?.turned).toBeCloseTo(0, 9);
  });

  it('is offered by the empty workspace beside loading the studio', async () => {
    const m = await start('?preset=empty', { store: createMemoryStore(), autosaveDelayMs: 0 });
    m.driver.act('page.panorama.add', 'press');
    await m.settle();
    expect(m.model.status?.windows).toBe(1);
    expect(m.driver.has('page.panorama.add')).toBe(false);
  });
});
