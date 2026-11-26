import { keyed } from '@wsb/uikit/handles';
import { createMemoryStore } from '@swf/persistence';
import { describe, expect, it } from 'vitest';
import type { ReferenceApp } from '../../src/app.js';
import type { ExperimentId } from '../../src/experiments.js';
import {
  CAPABILITY_ORDER,
  EXPERIMENT_IDS,
  EXPERIMENTS,
  experimentPlan,
} from '../../src/experiments.js';
import { DEFAULT_FEATURES } from '../../src/features.js';
import { ENGLISH } from '../../src/messages.js';
import { FIELD_OF_VIEW, fieldOfViewOf } from '../../src/modes.js';
import type { Mounted } from './shell-harness.js';
import { layout, start } from './shell-harness.js';

/**
 * The optional experiment panel (brief §5), driven as a person drives it: each experiment chosen
 * from its list, each capability switched on and off alone or with others, and the application
 * built without the panel.
 */

function appOf(m: Mounted): ReferenceApp {
  const app = m.model.app;
  if (app === null) {
    throw new Error('no application');
  }
  return app;
}

/** The studio, with the experiment panel open. */
async function studio(): Promise<Mounted> {
  const m = await start('?preset=studio', { store: createMemoryStore(), autosaveDelayMs: 0 });
  m.driver.act('workshop.view#experiments', 'press');
  await m.settle();
  return m;
}

/** What the head of the panel says. */
const heading = (m: Mounted) => {
  const read = m.driver.read('page.experiments.current');
  return read.present ? read.text : '';
};

/** The experiment the panel's list marks as the one the switches are. */
const marked = (m: Mounted) =>
  EXPERIMENT_IDS.filter(
    (id) =>
      m.root
        .querySelector(`[data-wsb="${keyed('page.experiments.run', id)}"]`)
        ?.closest('[aria-current="true"], [data-context="true"]') != null,
  );

/** Everything the feature modules install or take out, as the application holds it now. */
function installed(m: Mounted) {
  const app = appOf(m);
  const status = app.policies.status();
  return JSON.stringify({
    enabled: status.features.enabled,
    navigation: status.orbit.navigation,
    modes: app.modes.list().map((mode) => mode.id),
    mode: app.modes.current(),
    policies: app.router.policyIds(),
    keymap: app.router.settings().keymap.map((binding) => binding.command),
    views: [...m.root.querySelectorAll('[data-wsb^="workshop.view#"]')].map((view) =>
      view.getAttribute('data-wsb'),
    ),
    shown: representations(m),
  });
}

/** How the panorama shows each window now: in full, as a compact preview, or by its label. */
function representations(m: Mounted): Record<string, string | null> {
  const app = appOf(m);
  return Object.fromEntries(
    [...app.workspace.getState().nodes.values()]
      .filter((node) => node.kind === 'window' && node.status === 'active')
      .map((node) => [node.id, app.policies.representationOf(node.id)]),
  );
}

/**
 * What the modules have installed once the presentation has caught up: read frame after frame
 * until two reads agree (a window's representation follows a frame after the switch).
 */
async function steady(m: Mounted): Promise<string> {
  let last = installed(m);
  for (let frame = 0; frame < 30; frame += 1) {
    await m.settle();
    const now = installed(m);
    if (now === last) {
      return now;
    }
    last = now;
  }
  throw new Error(`the application did not settle: ${last}`);
}

describe('the experiment panel', () => {
  it('runs each experiment from its list: its capability alone, or every one, with the view set up to show it and no window changed', async () => {
    const m = await studio();
    const app = appOf(m);
    const board = app.workspace.getState().nodes.get('board');
    expect(board?.kind).toBe('window');
    await m.model.select('board');
    await m.settle();
    const windows = layout(m.model);
    const history = app.workspace.history().length;
    for (const id of [...EXPERIMENT_IDS.slice(1), 'everything'] as ExperimentId[]) {
      m.driver.act(keyed('page.experiments.run', id), 'press');
      await m.settle();
      const plan = experimentPlan(id, { target: true, orbitRoot: true });
      expect(m.model.policies?.features.enabled, id).toEqual(plan.enabled);
      expect(app.modes.current(), id).toBe(plan.view === 'panorama' ? 'panorama' : plan.view);
      expect(app.policies.status().orbit.navigation, id).toBe(plan.navigation);
      if (plan.wholeCircle) {
        expect(fieldOfViewOf(app.modes.panorama()), id).toBe(FIELD_OF_VIEW.max);
      }
      // The view switcher offers Focus and the Map exactly while their capabilities are on.
      const switcher = m.driver.read('editor.actions.mode');
      const offered = switcher.present ? switcher.text : '';
      expect(offered.includes(ENGLISH['mode.focus']), id).toBe(plan.enabled.focus);
      expect(offered.includes(ENGLISH['mode.map']), id).toBe(plan.enabled.map);
      // The panel names it, says how to try it, and marks it in the list.
      expect(heading(m), id).toContain(ENGLISH[EXPERIMENTS[id].name]);
      expect(heading(m), id).toContain(ENGLISH[EXPERIMENTS[id].trial].slice(0, 40));
      expect(marked(m), id).toEqual([id]);
      // Configuration alone: no window moved, nothing to undo.
      expect(layout(m.model), id).toEqual(windows);
      expect(app.workspace.history().length, id).toBe(history);
    }
    expect(m.model.policies?.features.enabled).toEqual(DEFAULT_FEATURES.enabled);
  });

  it('sets focus up only on a window there is, and says how to try it otherwise', async () => {
    const m = await studio();
    const app = appOf(m);
    expect(app.workspace.getState().selection).toEqual([]);
    m.driver.act(keyed('page.experiments.run', 'focus'), 'press');
    await m.settle();
    expect(app.modes.current()).toBe('panorama');
    expect(m.model.policies?.features.enabled.focus).toBe(true);
    expect(heading(m)).toContain('select a window and press F');
    expect(m.model.refusal).toBeNull();
  });

  it('makes a custom combination of a switch changed by hand, and names an experiment’s own combination however it is reached', async () => {
    const m = await studio();
    expect(heading(m)).toContain(ENGLISH['experiment.everything']);
    m.driver.act('page.experiments.snap.enabled', 'toggle');
    await m.settle();
    expect(heading(m)).toContain(ENGLISH['experiments.custom']);
    expect(marked(m)).toEqual([]);
    // It names what is on, in the experiments' order.
    expect(heading(m)).toContain(
      CAPABILITY_ORDER.filter((f) => f !== 'snap')
        .map((f) => ENGLISH[EXPERIMENTS[f].name])
        .join(', '),
    );
    // Every switch but depth's off, by hand: that is experiment 03.
    for (const feature of CAPABILITY_ORDER.filter((f) => f !== 'depth' && f !== 'snap')) {
      m.driver.act(`page.experiments.${feature}.enabled`, 'toggle');
      await m.settle();
    }
    expect(heading(m)).toContain(ENGLISH['experiment.depth']);
    expect(marked(m)).toEqual(['depth']);
    // Combined with a second, it is custom again; every switch off says none is on.
    m.driver.act('page.experiments.map.enabled', 'toggle');
    await m.settle();
    expect(heading(m)).toContain(ENGLISH['experiments.custom']);
    m.driver.act('page.experiments.map.enabled', 'toggle');
    m.driver.act('page.experiments.depth.enabled', 'toggle');
    await m.settle();
    expect(heading(m)).toContain(ENGLISH['experiments.custom.none']);
    // Back to every capability.
    m.driver.act(keyed('page.experiments.run', 'everything'), 'press');
    await m.settle();
    expect(m.model.policies?.features.enabled).toEqual(DEFAULT_FEATURES.enabled);
  });

  it('drives each capability’s own module: a switch does exactly what configuring the module does, and its behaviour shows', async () => {
    const m = await studio();
    const app = appOf(m);
    const all = await steady(m);
    for (const feature of CAPABILITY_ORDER) {
      m.driver.act(`page.experiments.${feature}.enabled`, 'toggle');
      const switched = await steady(m);
      // Off, the module's work is gone from the application.
      expect(switched, feature).not.toBe(all);
      m.driver.act(`page.experiments.${feature}.enabled`, 'toggle');
      expect(await steady(m), feature).toBe(all);
      // The module configured directly, with no panel in the way, gives the very same application.
      app.policies.configure({ enabled: { [feature]: false } });
      expect(await steady(m), feature).toBe(switched);
      app.policies.configure({ enabled: { [feature]: true } });
      expect(await steady(m), feature).toBe(all);
    }
    // Semantic depth's behaviour, before and after: on, the farther windows show a compact
    // preview or their label; off, every window shows its content, however far.
    const reduced = () => Object.values(representations(m)).filter((r) => r !== 'full').length;
    expect(reduced()).toBeGreaterThan(0);
    m.driver.act('page.experiments.depth.enabled', 'toggle');
    await steady(m);
    expect(reduced()).toBe(0);
  });

  it('can be left out of a build: every capability stays on, with the everyday controls in place', async () => {
    const m = await start(
      '?preset=studio',
      { store: createMemoryStore(), autosaveDelayMs: 0 },
      { experiments: false },
    );
    const app = appOf(m);
    expect(m.driver.has('workshop.view#experiments')).toBe(false);
    expect(m.driver.has('workshop.view#scene')).toBe(true);
    expect(m.model.policies?.features).toEqual(DEFAULT_FEATURES);
    // The everyday controls: the views, what drags turn, the view's sliders, the radar, the
    // inspector and the command list.
    for (const handle of [
      'editor.actions.mode',
      'editor.actions.navigation',
      'editor.actions.commands',
      'page.view.fov',
      'page.view.heading',
      'page.view.workspace',
      'page.radar',
      'page.inspector',
      'workshop.view#workspaces',
    ]) {
      expect(m.driver.has(handle), handle).toBe(true);
    }
    expect(app.modes.list().map((mode) => mode.id)).toEqual([
      'panorama',
      'focus',
      'map',
      'overview',
    ]);
    // The command list offers no experiment, nor any capability's switch.
    m.driver.act('editor.actions.commands', 'press');
    await m.settle();
    const palette = () => {
      const read = m.driver.read('application.palette');
      return read.present ? read.text : '';
    };
    m.driver.act('application.palette.field', 'set', 'experiment');
    await m.settle();
    expect(palette()).not.toContain('Run experiment');
    m.driver.act('application.palette.field', 'set', 'Turn off');
    await m.settle();
    expect(palette()).not.toContain(`Turn off ${ENGLISH['feature.depth']}`);
  });

  it('offers its experiments and switches in the command list when the build carries it', async () => {
    const m = await studio();
    m.driver.act('editor.actions.commands', 'press');
    await m.settle();
    m.driver.act('application.palette.field', 'set', 'experiment 03');
    await m.settle();
    const read = m.driver.read('application.palette');
    expect(read.present ? read.text : '').toContain(
      `Run experiment 03: ${ENGLISH['experiment.depth']}`,
    );
  });
});
