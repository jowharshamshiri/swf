import type { SceneCommand, SceneState } from '@swf/core';
import { createWorkspace } from '@swf/core';
import { describe, expect, it } from 'vitest';
import { planPreset, presetCommands } from '../src/presets.js';
import { CAMERA_ID, DEFAULT_FEATURES, FOCUS_ID, poseOf } from '@swf/navigation';
import type { ScenarioWorld } from '../src/scenarios.js';
import {
  createScenarios,
  SCENARIO_IDS,
  SCENARIO_LAYOUT,
  SCENARIOS,
  ScenarioRefusal,
} from '../src/scenarios.js';
import type { SpaceEntry } from '@swf/persistence';

/** The studio in a workspace of its own, changed by the test as an operator would. */
function studio() {
  const ws = createWorkspace({ id: 'test', now: () => 0 });
  const seeded = ws.transaction([
    { type: 'camera.create', camera: { id: CAMERA_ID } },
    ...presetCommands(planPreset('studio', 1)),
  ]);
  if (seeded.status !== 'committed') {
    throw new Error('the studio could not be seeded');
  }
  let mode = 'panorama';
  let heading = 0;
  let spaces: SpaceEntry[] = [];
  let space = 'Studio';
  let switches = 1;
  const world = (): ScenarioWorld => {
    const scene: SceneState = ws.getState();
    return {
      scene,
      mode,
      cameraHeading: heading,
      pose: (id) =>
        scene.nodes.get(id)?.status === 'active' ? poseOf(scene, id, [0, 0, 0]) : null,
      depth: DEFAULT_FEATURES.depth,
      spaces,
      space,
      switches,
    };
  };
  const change = (...commands: SceneCommand[]) => {
    const result = ws.transaction(commands);
    if (result.status !== 'committed') {
      throw new Error(`the change was not made: ${JSON.stringify(result)}`);
    }
  };
  return {
    world,
    change,
    show(next: string) {
      mode = next;
    },
    face(degrees: number) {
      heading = degrees;
    },
    /** Stores what is shown as a space, at a time, and shows it. */
    saveAs(name: string, at: number) {
      spaces = [
        ...spaces.filter((e) => e.name !== name),
        { name, seeded: false, stored: { savedAt: at, bytes: 1 } },
      ];
      space = name;
    },
    /** Shows another space; the scene stands as the test leaves it. */
    switchTo(name: string) {
      space = name;
      switches += 1;
    },
  };
}

describe('guided scenarios', () => {
  it('each start from their first step and have three steps the studio can do, four to save and restore', () => {
    for (const id of SCENARIO_IDS) {
      expect(SCENARIOS[id].steps).toHaveLength(id === 'restore' ? 4 : 3);
      expect(SCENARIOS[id].id).toBe(id);
    }
  });

  it('saves the layout as a space of its own, changes it, and finds it as left after switching away and back', async () => {
    const s = studio();
    const scenarios = createScenarios({ world: () => Promise.resolve(s.world()) });
    scenarios.start('restore');
    await scenarios.observe();
    expect(await scenarios.demonstration()).toEqual({
      kind: 'command',
      command: { id: 'reference.space.saveAs', params: { name: SCENARIO_LAYOUT } },
    });
    s.saveAs(SCENARIO_LAYOUT, 10);
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(1);
    // Moving a window is the change.
    s.change({
      type: 'node.patch',
      id: 'builds',
      transform: { position: [2, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    });
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(2);
    expect(await scenarios.demonstration()).toEqual({
      kind: 'command',
      command: { id: 'reference.space.switch', params: { name: 'Studio' } },
    });
    s.switchTo('Studio');
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(3);
    // Back, but changed since it was left: not as left.
    const desk = s.world().scene.nodes.get('desk')?.transform;
    s.change({
      type: 'node.patch',
      id: 'desk',
      transform: { position: [-2, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    });
    s.switchTo(SCENARIO_LAYOUT);
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(3);
    if (desk === undefined) {
      throw new Error('the studio has its desk');
    }
    s.change({ type: 'node.patch', id: 'desk', transform: desk });
    s.switchTo('Studio');
    s.switchTo(SCENARIO_LAYOUT);
    await scenarios.observe();
    expect(scenarios.status()).toMatchObject({ steps: 4, done: 4, finished: true });
  });

  it('tick steps off in order, each once it is done while due, and stay finished', async () => {
    const s = studio();
    const scenarios = createScenarios({ world: () => Promise.resolve(s.world()) });
    const told: (number | null)[] = [];
    scenarios.subscribe(() => told.push(scenarios.status()?.done ?? null));
    scenarios.start('focus');
    await scenarios.observe();
    expect(scenarios.status()).toEqual({ scenario: 'focus', steps: 3, done: 0, finished: false });

    // Leaving focus is the last step: done before its turn, it counts for nothing.
    s.change({ type: 'focus.set', id: 'desk' });
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(0);

    s.show(FOCUS_ID);
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(1);
    // Focusing a neighbour asks for a change since the step became due: the same focus is none.
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(1);

    s.change({ type: 'focus.set', id: 'builds' });
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(2);

    s.show('panorama');
    await scenarios.observe();
    expect(scenarios.status()).toEqual({ scenario: 'focus', steps: 3, done: 3, finished: true });
    s.show(FOCUS_ID);
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(3);
    expect(told).toEqual([0, 1, 2, 3]);
    expect(await scenarios.demonstration()).toBeNull();
  });

  it('weighs no step before the world it became due in is read, however a look and a start interleave', async () => {
    const s = studio();
    const scenarios = createScenarios({ world: () => Promise.resolve(s.world()) });
    // A change looked at as the scenario starts: the look runs once the scenario is under way.
    // Saving is weighed against what was saved when the step became due.
    const look = scenarios.observe();
    scenarios.start('restore');
    await look;
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(0);
  });

  it('ticks off every step one change did, in order', async () => {
    const s = studio();
    const scenarios = createScenarios({ world: () => Promise.resolve(s.world()) });
    scenarios.start('hidden');
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(0);
    // Going to Messages selects it and turns the camera to it: two steps at once, not the third.
    const messages = s.world().pose('messages');
    s.change({ type: 'selection.set', ids: ['messages'] });
    s.face(messages?.heading ?? NaN);
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(2);
  });

  it('shows the step due as the application’s controls would', async () => {
    const s = studio();
    const scenarios = createScenarios({ world: () => Promise.resolve(s.world()) });
    scenarios.start('behind');
    expect(await scenarios.demonstration()).toEqual({
      kind: 'command',
      command: { id: 'swf.window.inspect', params: { id: 'desk' } },
    });
    s.change({ type: 'selection.set', ids: ['desk'] });
    await scenarios.observe();
    // Moving it behind puts it straight across the camera.
    const desk = s.world().pose('desk');
    const shown = await scenarios.demonstration();
    expect(shown).toEqual({
      kind: 'command',
      command: {
        id: 'swf.window.place',
        params: { id: 'desk', x: -(desk?.position[0] ?? NaN), z: -(desk?.position[2] ?? NaN) },
      },
    });
  });

  it('never ticks off a step whose window is gone, and refuses to show it, naming the window', async () => {
    const s = studio();
    const scenarios = createScenarios({ world: () => Promise.resolve(s.world()) });
    scenarios.start('depth');
    s.change({ type: 'selection.set', ids: ['media'] });
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(1);
    s.change(
      { type: 'selection.set', ids: [] },
      { type: 'node.delete', id: 'media', mode: 'subtree' },
    );
    await scenarios.observe();
    expect(scenarios.status()?.done).toBe(1);
    const refused = scenarios.demonstration();
    await expect(refused).rejects.toBeInstanceOf(ScenarioRefusal);
    await expect(refused).rejects.toThrow('"media" is no longer in the workspace');
  });

  it('stops the scenario under way, and refuses to stop when none is', async () => {
    const s = studio();
    const scenarios = createScenarios({ world: () => Promise.resolve(s.world()) });
    expect(() => {
      scenarios.stop();
    }).toThrow('no scenario is under way');
    scenarios.start('compose');
    scenarios.start('restore');
    expect(scenarios.status()?.scenario).toBe('restore');
    scenarios.stop();
    expect(scenarios.status()).toBeNull();
    // A look after the stop changes nothing.
    await scenarios.observe();
    expect(scenarios.status()).toBeNull();
  });
});
