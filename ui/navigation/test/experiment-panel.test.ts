import { describe, expect, it } from 'vitest';
import type { NavigationCommandId } from '@swf/navigation';

describe('the experiment panel holds only configuration (brief §5: no logic duplicated)', () => {
  const source = Object.values(
    import.meta.glob<string>('../src/ExperimentPanel.svelte', {
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
  const CONFIGURATION: readonly NavigationCommandId[] = [
    'swf.experiment.run',
    'swf.feature.set',
    'swf.feature.reset',
    'swf.snap.configure',
    'swf.depth.configure',
    'swf.navigation.set',
    'swf.orbit.designate',
    'swf.orbit.turn',
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
      expect(from, `a value imported from ${from}`).toBe('@swf/navigation');
      const imported = (names ?? '')
        .replace(/[{}\s]/g, '')
        .split(',')
        .sort();
      expect(imported).toEqual(['CAPABILITY_ORDER', 'EXPERIMENTS', 'EXPERIMENT_IDS']);
    }
  });

  it('acts only through navigation’s configuration commands, never on the navigation itself', () => {
    const runs = [...source.matchAll(/model\.run\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(runs)).toEqual(new Set(CONFIGURATION));
    // What it reads of the model: its words, the policies' status, the experiment the
    // switches are, the orbit readings, and the refusals of its own commands.
    const members = new Set([...source.matchAll(/(?<![./\w])model\.(\w+)/g)].map((m) => m[1]));
    expect([...members].sort()).toEqual(
      [
        'experiment',
        'placeOf',
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
