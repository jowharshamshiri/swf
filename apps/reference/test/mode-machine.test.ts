import type { Quat } from '@swf/math';
import { describe, expect, it } from 'vitest';
import type { ModeTraits, ViewSettings } from '../src/mode-machine.js';
import { initialMode, observedMode, transition } from '../src/mode-machine.js';

const WIDE = { id: 'equirectangular/1', config: { horizontal: 360, vertical: 120 } };
const NARROW = { id: 'equirectangular/1', config: { horizontal: 40, vertical: 25 } };
const AHEAD: Quat = [0, 0, 0, 1];
const TURNED: Quat = [0, 0.5, 0, Math.sqrt(0.75)];

const traits = (mode: string): ModeTraits => ({ restoresView: mode === 'focus' });
const view = (mode: string, projection = WIDE, camera: Quat = AHEAD): ViewSettings => ({
  mode,
  projection,
  camera,
});

describe('the mode machine', () => {
  it('remembers the view it switched from, and goes back to it', () => {
    const start = initialMode('panorama');
    const toMap = transition(start, { kind: 'switch', to: 'map' }, view('panorama'), traits);
    expect(toMap).toMatchObject({ kind: 'next', mode: 'map', projection: null, camera: null });
    if (toMap.kind !== 'next') throw new Error('refused');
    expect(toMap.machine).toEqual({ mode: 'map', from: view('panorama') });

    const back = transition(toMap.machine, { kind: 'back' }, view('map'), traits);
    expect(back).toMatchObject({ kind: 'next', mode: 'panorama', projection: WIDE, camera: null });
    if (back.kind !== 'next') throw new Error('refused');
    expect(back.machine).toEqual({ mode: 'panorama', from: null });
  });

  it('puts the camera back when a mode that turned it is left, by any route', () => {
    const inFocus = transition(
      initialMode('map'),
      { kind: 'switch', to: 'focus' },
      view('map', WIDE, AHEAD),
      traits,
    );
    if (inFocus.kind !== 'next') throw new Error('refused');
    // Focus turned the camera and narrowed the view.
    const focused = view('focus', NARROW, TURNED);

    const back = transition(inFocus.machine, { kind: 'back' }, focused, traits);
    expect(back).toMatchObject({ kind: 'next', mode: 'map', projection: WIDE, camera: AHEAD });

    const away = transition(inFocus.machine, { kind: 'switch', to: 'overview' }, focused, traits);
    expect(away).toMatchObject({ kind: 'next', mode: 'overview', projection: null, camera: AHEAD });
    if (away.kind !== 'next') throw new Error('refused');
    // The view left is the one focus was entered from, not focus's own.
    expect(away.machine.from).toEqual(view('map', WIDE, AHEAD));
  });

  it('enters the same mode again without forgetting where it came from', () => {
    const inFocus = transition(
      initialMode('panorama'),
      { kind: 'switch', to: 'focus' },
      view('panorama'),
      traits,
    );
    if (inFocus.kind !== 'next') throw new Error('refused');
    const again = transition(
      inFocus.machine,
      { kind: 'switch', to: 'focus' },
      view('focus', NARROW, TURNED),
      traits,
    );
    expect(again).toMatchObject({ kind: 'next', mode: 'focus', camera: null });
    if (again.kind !== 'next') throw new Error('refused');
    expect(again.machine.from).toEqual(view('panorama'));
  });

  it('refuses to go back with nowhere to go, and a view the machine is not in', () => {
    expect(transition(initialMode('panorama'), { kind: 'back' }, view('panorama'), traits)).toEqual(
      {
        kind: 'refused',
        reason: 'the panorama mode was not entered from another view',
      },
    );
    expect(
      transition(initialMode('panorama'), { kind: 'switch', to: 'map' }, view('map'), traits),
    ).toMatchObject({ kind: 'refused' });
  });

  it('forgets the view to go back to when the mode changes by another route', () => {
    const inMap = transition(
      initialMode('panorama'),
      { kind: 'switch', to: 'map' },
      view('panorama'),
      traits,
    );
    if (inMap.kind !== 'next') throw new Error('refused');
    expect(observedMode(inMap.machine, 'map')).toBe(inMap.machine);
    expect(observedMode(inMap.machine, 'overview')).toEqual({ mode: 'overview', from: null });
  });
});
