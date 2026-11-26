import { describe, expect, it } from 'vitest';
import type { AppCommandId } from '../src/commands.js';
import type { ExperimentId } from '../src/experiments.js';
import {
  CAPABILITY_ORDER,
  EXPERIMENT_IDS,
  EXPERIMENTS,
  experimentOf,
  experimentPlan,
} from '../src/experiments.js';
import type { FeatureId } from '../src/features.js';
import { FEATURE_IDS } from '../src/features.js';
import { ENGLISH } from '../src/messages.js';

/** Every combination of the eight switches, as a number's bits in the modules' order. */
const combinations = (): Record<FeatureId, boolean>[] =>
  Array.from(
    { length: 2 ** FEATURE_IDS.length },
    (_, bits) =>
      Object.fromEntries(FEATURE_IDS.map((id, i) => [id, (bits & (1 << i)) !== 0])) as Record<
        FeatureId,
        boolean
      >,
  );

const ANY = { target: true, orbitRoot: true } as const;

describe('the experiments (brief §5)', () => {
  it('number the eight capabilities in the brief’s order after Everything combined, each named and described', () => {
    expect(EXPERIMENT_IDS).toEqual(['everything', ...CAPABILITY_ORDER]);
    expect([...CAPABILITY_ORDER].sort()).toEqual([...FEATURE_IDS].sort());
    expect(EXPERIMENT_IDS.map((id) => EXPERIMENTS[id].number)).toEqual([
      '∞',
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
      '07',
      '08',
    ]);
    for (const id of EXPERIMENT_IDS) {
      for (const message of [
        EXPERIMENTS[id].name,
        EXPERIMENTS[id].summary,
        EXPERIMENTS[id].trial,
      ]) {
        expect(ENGLISH[message], message).toMatch(/\S/);
      }
    }
  });

  it('turn their capability on and every other off, or every one on for Everything combined', () => {
    expect(experimentPlan('everything', ANY).enabled).toEqual(
      Object.fromEntries(FEATURE_IDS.map((id) => [id, true])),
    );
    for (const feature of CAPABILITY_ORDER) {
      const enabled = experimentPlan(feature, ANY).enabled;
      expect(
        FEATURE_IDS.filter((id) => enabled[id]),
        feature,
      ).toEqual([feature]);
    }
  });

  it('name exactly the nine combinations that are experiments, and every other a custom one', () => {
    const named = new Map<ExperimentId, number>();
    for (const enabled of combinations()) {
      const experiment = experimentOf(enabled);
      if (experiment !== null) {
        expect(experimentPlan(experiment, ANY).enabled).toEqual(enabled);
        named.set(experiment, (named.get(experiment) ?? 0) + 1);
      }
    }
    expect([...named.keys()].sort()).toEqual([...EXPERIMENT_IDS].sort());
    expect([...named.values()].every((count) => count === 1)).toBe(true);
    // Two on, seven on, and none on are custom.
    const two = { ...experimentPlan('focus', ANY).enabled, map: true };
    expect(experimentOf(two)).toBeNull();
    expect(experimentOf({ ...experimentPlan('everything', ANY).enabled, snap: false })).toBeNull();
    expect(experimentOf({ ...experimentPlan('focus', ANY).enabled, focus: false })).toBeNull();
  });

  it('set the view up to show their capability, as far as the scene lets them', () => {
    const plan = (id: ExperimentId, target: boolean, orbitRoot: boolean) => {
      const { view, navigation, wholeCircle } = experimentPlan(id, { target, orbitRoot });
      return { view, navigation, wholeCircle };
    };
    const panorama = { view: 'panorama', navigation: 'camera', wholeCircle: false };
    expect(plan('focus', true, true)).toEqual({ ...panorama, view: 'focus' });
    // Nothing selected or focused: there is no window to focus, and the panorama stays.
    expect(plan('focus', false, true)).toEqual(panorama);
    expect(plan('map', false, false)).toEqual({ ...panorama, view: 'map' });
    expect(plan('orbit', false, true)).toEqual({ ...panorama, navigation: 'orbit' });
    // No group designated: drags can only turn the camera.
    expect(plan('orbit', true, false)).toEqual(panorama);
    expect(plan('cursor', true, true)).toEqual({ ...panorama, wholeCircle: true });
    for (const id of ['everything', 'depth', 'snap', 'composition', 'persistence'] as const) {
      for (const [target, orbitRoot] of [
        [true, true],
        [false, false],
      ] as const) {
        expect(plan(id, target, orbitRoot), id).toEqual(panorama);
      }
    }
  });
});

describe('the experiment panel holds only configuration (brief §5: no logic duplicated)', () => {
  const source = Object.values(
    import.meta.glob<string>('../src/shell/ExperimentsView.svelte', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )[0];
  if (source === undefined) {
    throw new Error('the experiment panel’s source is not where the test reads it');
  }
  const script = /<script lang="ts">([\s\S]*?)<\/script>/.exec(source)?.[1] ?? '';

  /** The commands that only configure: the feature modules' switches and settings, and the view. */
  const CONFIGURATION: readonly AppCommandId[] = [
    'reference.experiment.run',
    'reference.feature.set',
    'reference.feature.reset',
    'reference.snap.configure',
    'reference.depth.configure',
    'reference.navigation.set',
    'reference.orbit.designate',
    'reference.orbit.turn',
  ];

  it('imports nothing of any capability’s module: the kit, the experiments’ table, and types', () => {
    const imports = [...script.matchAll(/^\s*import\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)';/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, type, names, from] of imports) {
      if (type !== undefined || from === undefined) {
        continue;
      }
      if (from.startsWith('@wsb/uikit/')) {
        continue;
      }
      expect(from, `a value imported from ${from}`).toBe('../experiments.js');
      const imported = (names ?? '')
        .replace(/[{}\s]/g, '')
        .split(',')
        .sort();
      expect(imported).toEqual(['CAPABILITY_ORDER', 'EXPERIMENTS', 'EXPERIMENT_IDS']);
    }
  });

  it('acts only through the application’s configuration commands, never on the application itself', () => {
    const runs = [...source.matchAll(/model\.run\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(runs)).toEqual(new Set(CONFIGURATION));
    // What it reads of the shell's model: its words, the policies' status, the experiment the
    // switches are, the orbit readings, and the refusals of its own commands.
    const members = new Set([...source.matchAll(/(?<![./\w])model\.(\w+)/g)].map((m) => m[1]));
    expect([...members].sort()).toEqual(
      [
        'experiment',
        'isFeatureRefusal',
        'messages',
        'orbitScene',
        'policies',
        'refusal',
        'refusalText',
        'run',
      ].sort(),
    );
  });
});
