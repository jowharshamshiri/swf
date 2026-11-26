import { describe, expect, it } from 'vitest';
import type { ChallengeCandidate } from '../src/challenge.js';
import { createChallenge, summarize } from '../src/challenge.js';

/** A task on a clock the test moves, drawing what the test says. */
function task(draws: number[] = [0]) {
  let now = 1000;
  const challenge = createChallenge({
    now: () => now,
    random: () => {
      const draw = draws.shift();
      if (draw === undefined) {
        throw new Error('the test gave no more draws');
      }
      return draw;
    },
  });
  return {
    challenge,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const windows: ChallengeCandidate[] = [
  { id: 'ahead', label: 'Ahead', behind: false },
  { id: 'left', label: 'Left', behind: false },
  { id: 'back', label: 'Back', behind: true },
  { id: 'rear', label: 'Rear', behind: true },
];

describe('the timed window-finding task', () => {
  it('names a window behind the camera whenever one is, never the one selected', () => {
    for (const draw of [0, 0.25, 0.5, 0.75, 0.999]) {
      const { challenge } = task([draw]);
      const run = challenge.start('map', windows, 'back');
      // Only "rear" is behind and not selected.
      expect(run?.target).toBe('rear');
      expect(run?.label).toBe('Rear');
    }
    // With nothing behind, any window but the selected one.
    const named = new Set<string>();
    for (const draw of [0, 0.34, 0.67]) {
      const { challenge } = task([draw]);
      const run = challenge.start(
        'camera',
        windows.filter((w) => !w.behind),
        'ahead',
      );
      named.add(run?.target ?? '');
    }
    expect([...named]).toEqual(['left']);
  });

  it('names nothing when the only window is the selected one', () => {
    const { challenge } = task([0.5]);
    expect(challenge.start('camera', windows.slice(0, 1), 'ahead')).toBeNull();
    expect(challenge.status().run).toBeNull();
  });

  it('counts presses and keys until the named window is selected, then records the run', () => {
    const { challenge, advance } = task([0]);
    const tells: number[] = [];
    challenge.subscribe(() => tells.push(challenge.status().run?.actions ?? -1));
    // Presses before a run count for nothing.
    challenge.act();
    const run = challenge.start('overview', windows, null);
    expect(run?.target).toBe('back');
    challenge.act();
    challenge.act();
    advance(800);
    challenge.selected('left');
    challenge.act();
    expect(challenge.status().run?.actions).toBe(3);
    advance(450);
    challenge.selected('back');
    const status = challenge.status();
    expect(status.run).toBeNull();
    expect(status.records).toEqual([
      { target: 'back', label: 'Back', method: 'overview', ms: 1250, actions: 3 },
    ]);
    // Told once as the run started, at each counted press, and as it ended.
    expect(tells).toEqual([0, 1, 2, 3, -1]);
    // After the run, presses and selections change nothing.
    challenge.act();
    challenge.selected('back');
    expect(challenge.status().records).toHaveLength(1);
  });

  it('ends a run unfinished when its window is removed, or when given up, and forgets runs on request', () => {
    const { challenge, advance } = task([0, 0.6, 0]);
    challenge.start('camera', windows, null);
    challenge.removed();
    expect(challenge.status()).toMatchObject({ run: null, records: [], ended: 'removed' });
    challenge.start('map', windows, null);
    expect(challenge.status().ended).toBeNull();
    challenge.cancel();
    expect(challenge.status()).toMatchObject({ run: null, records: [], ended: null });
    expect(() => {
      challenge.cancel();
    }).toThrow('no run is under way');
    challenge.start('search', windows, null);
    advance(10);
    challenge.selected('back');
    expect(challenge.status().records).toHaveLength(1);
    challenge.clear();
    expect(challenge.status().records).toEqual([]);
  });

  it('sums the runs up by way of navigating, in the ways’ order', () => {
    const record = (method: 'camera' | 'map', ms: number, actions: number) => ({
      target: 'back',
      label: 'Back',
      method,
      ms,
      actions,
    });
    expect(
      summarize([record('map', 3000, 4), record('camera', 5000, 9), record('map', 1000, 2)]),
    ).toEqual([
      { method: 'camera', runs: 1, bestMs: 5000, meanMs: 5000, meanActions: 9 },
      { method: 'map', runs: 2, bestMs: 1000, meanMs: 2000, meanActions: 3 },
    ]);
    expect(summarize([])).toEqual([]);
  });

  it('refuses a clock that runs backwards and a draw outside [0, 1)', () => {
    const { challenge, advance } = task([0, 1]);
    challenge.start('camera', windows, null);
    advance(-5);
    expect(() => {
      challenge.selected('back');
    }).toThrow('ran backwards');
    expect(() => challenge.start('camera', windows, null)).toThrow('a draw is in [0, 1)');
  });
});
