import { describe, expect, it } from 'vitest';
import type {
  SpacesEvent,
  SpacesMachine,
  SpacesSaverState,
  CompNode,
  CompScene,
  Hit,
  Presentation,
  SurfaceEvent,
  WorkspacesEvent,
  WorkspacesMachine,
} from '../src/index.js';
import { models } from '../src/index.js';

/**
 * The models refuse input they cannot decide on (a number that is not finite, an event after
 * disposal), decide the same question the same way in every step that asks it, and announce
 * exactly what changes.
 */

const NON_FINITE = [NaN, Infinity, -Infinity];

describe('the wrapped cursor', () => {
  it('refuses a pointer whose horizontal place is not finite, taken or not', () => {
    for (const x of NON_FINITE) {
      expect(models.wrapPointerStep(['p'], 'p', { kind: 'move' }, x, 100, true)).toEqual({
        kind: 'invalidX',
      });
      expect(models.wrapPointerStep([], 'p', { kind: 'move' }, x, 100, true)).toEqual({
        kind: 'invalidX',
      });
    }
  });

  it('still wraps a finite place, and still refuses a width that is not finite first', () => {
    expect(models.wrapPointerStep(['p'], 'p', { kind: 'move' }, 130, 100, true)).toEqual({
      kind: 'wrapped',
      x: 30,
      cursor: true,
    });
    expect(models.wrapPointerStep(['p'], 'p', { kind: 'move' }, NaN, NaN, true)).toEqual({
      kind: 'invalidWidth',
    });
  });
});

describe('the reference application’s workspaces', () => {
  const disposed: WorkspacesMachine = { autosave: true, pending: false, disposed: true };
  const events: WorkspacesEvent[] = [
    { kind: 'setAutosave', on: false, saver: { kind: 'dirty' } },
    { kind: 'changed' },
    { kind: 'fired' },
    { kind: 'saveNow' },
    { kind: 'cleared' },
  ];

  it('refuses every event once disposed, and does nothing for it', () => {
    for (const event of events) {
      const step = models.workspacesStep(disposed, event);
      expect(step, event.kind).toEqual({
        next: disposed,
        cancelTimer: false,
        startTimer: false,
        save: false,
        announce: false,
        refusal: 'the workspaces are disposed',
      });
    }
  });

  it('takes a second disposal as done, refusing nothing', () => {
    const step = models.workspacesStep(disposed, { kind: 'dispose' });
    expect(step.next).toEqual(disposed);
    expect(step.refusal).toBeNull();
    expect(step.cancelTimer).toBe(false);
  });

  it('still saves now before disposal', () => {
    const live: WorkspacesMachine = { autosave: true, pending: false, disposed: false };
    expect(models.workspacesStep(live, { kind: 'saveNow' }).save).toBe(true);
  });
});

describe('named spaces', () => {
  const idle = models.spacesInitial();
  const shown: SpacesMachine = { ...idle, active: 'Studio' };
  const request = (
    target: string,
    saver: SpacesSaverState['kind'],
    on = true,
    known = true,
  ): SpacesEvent => ({
    kind: 'request',
    target,
    known,
    on,
    saver: { kind: saver },
  });

  it('opens the first space at once, and another at once only when the space shown is saved', () => {
    expect(models.spacesStep(idle, request('Studio', 'dirty', false)).openTarget).toBe('Studio');
    expect(models.spacesStep(shown, request('Research', 'clean')).openTarget).toBe('Research');
    for (const saver of ['dirty', 'saving', 'failed'] as const) {
      const step = models.spacesStep(shown, request('Research', saver));
      expect(step.openTarget, saver).toBeNull();
      expect(step.save, saver).toBe(true);
      expect(step.next.phase).toEqual({ kind: 'saving', target: 'Research' });
    }
  });

  it('asks after a failed save, and opens only once the operator gives the changes up', () => {
    const saving: SpacesMachine = { ...shown, phase: { kind: 'saving', target: 'Research' } };
    const failed = models.spacesStep(saving, { kind: 'saved', ok: false });
    expect(failed).toMatchObject({ ask: true, openTarget: null });
    const asking = failed.next;
    expect(models.spacesStep(asking, { kind: 'answer', discard: false }).next).toEqual(shown);
    expect(models.spacesStep(asking, { kind: 'answer', discard: true }).openTarget).toBe(
      'Research',
    );
    // Nothing else is taken meanwhile.
    expect(models.spacesStep(asking, request('Planning', 'clean')).refusal).toEqual({
      kind: 'busy',
    });
  });

  it('refuses another space while saving is off, an unknown one, and everything once disposed', () => {
    expect(models.spacesStep(shown, request('Research', 'clean', false)).refusal).toEqual({
      kind: 'off',
    });
    expect(models.spacesStep(shown, request('Nowhere', 'clean', true, false)).refusal).toEqual({
      kind: 'unknown',
    });
    const disposed = models.spacesStep(shown, { kind: 'dispose' }).next;
    expect(models.spacesStep(disposed, request('Research', 'clean')).refusal).toEqual({
      kind: 'disposed',
    });
  });
});

describe('composition', () => {
  const node = (id: string, kind: string, fields: Partial<CompNode> = {}): CompNode => ({
    id,
    kind,
    active: true,
    label: null,
    parentId: null,
    childIds: [],
    surfaceIds: [],
    ...fields,
  });
  const scene = (sourceChildren: string[]): CompScene => ({
    nodes: [
      node('g', 'group', { childIds: ['a', 'b'] }),
      node('a', 'window', { parentId: 'g', childIds: sourceChildren, surfaceIds: ['s'] }),
      node('b', 'window', { parentId: 'g', surfaceIds: ['t'] }),
      ...sourceChildren.map((id) => node(id, 'note', { parentId: 'a' })),
    ],
    surfaces: [
      { id: 's', label: null, owner: 'a' },
      { id: 't', label: null, owner: 'b' },
    ],
    orbitRootId: null,
  });
  const ref = (id: string) => ({ id, shown: id });
  const reason = '“a” holds other nodes and cannot be emptied';

  it('refuses to move the last surface out of a window that holds nodes, as merging it is refused', () => {
    expect(
      models.compositionPlan(scene(['n']), { kind: 'move', surface: ref('s'), window: ref('b') }),
    ).toEqual({ kind: 'refused', field: 'surfaceId', reason });
    expect(
      models.compositionPlan(scene(['n']), { kind: 'merge', window: ref('a'), target: ref('b') }),
    ).toEqual({ kind: 'refused', field: 'windowId', reason });
  });

  it('still moves the last surface out of a window that holds no nodes, removing it', () => {
    expect(
      models.compositionPlan(scene([]), { kind: 'move', surface: ref('s'), window: ref('b') }),
    ).toEqual({
      kind: 'move',
      surface: 's',
      target: 'b',
      laidOut: ['t', 's'],
      source: 'a',
      left: [],
    });
  });
});

describe('arbitration', () => {
  const bid = (priority: number, policy: string) => ({
    kind: { kind: 'drag' as const },
    pointers: 1n,
    priority,
    policy,
  });
  const hit = (node: string, fields: Partial<Hit> = {}): Hit => ({
    node,
    surface: null,
    region: { kind: 'content' },
    distance: 1,
    priority: 0,
    occluding: false,
    ...fields,
  });

  it('refuses a bid whose priority is not finite, eligible or not', () => {
    for (const priority of NON_FINITE) {
      expect(models.bestBid([bid(1, 'a'), bid(priority, 'b')], { kind: 'drag' }, 1n)).toEqual({
        kind: 'invalidPriority',
        bid: 1n,
      });
      expect(
        models.bestBid(
          [bid(1, 'a'), { ...bid(priority, 'b'), kind: { kind: 'tap' } }],
          { kind: 'drag' },
          1n,
        ),
      ).toEqual({ kind: 'invalidPriority', bid: 1n });
    }
  });

  it('still picks the highest priority, then the lower policy ID, among finite bids', () => {
    expect(models.bestBid([bid(1, 'b'), bid(2, 'c'), bid(2, 'a')], { kind: 'drag' }, 1n)).toEqual({
      kind: 'winner',
      bid: 2n,
    });
    expect(models.bestBid([bid(1, 'b')], { kind: 'tap' }, 1n)).toEqual({ kind: 'noBid' });
  });

  it('refuses a hit whose distance or priority is not finite, naming it and the field', () => {
    for (const value of NON_FINITE) {
      expect(models.pickOrder([hit('a'), hit('b', { distance: value })], 1e-6)).toEqual({
        kind: 'invalidHit',
        hit: 1n,
        field: 'distance',
      });
      expect(models.pickOrder([hit('a'), hit('b', { priority: value })], 1e-6)).toEqual({
        kind: 'invalidHit',
        hit: 1n,
        field: 'priority',
      });
    }
  });

  it('refuses a depth tolerance that is not finite and at least zero', () => {
    for (const tolerance of [...NON_FINITE, -1]) {
      expect(models.pickOrder([hit('a')], tolerance)).toEqual({ kind: 'invalidTolerance' });
    }
  });

  it('still orders finite hits, nearer first', () => {
    expect(models.pickOrder([hit('a', { distance: 2 }), hit('b', { distance: 1 })], 1e-6)).toEqual({
      kind: 'ordered',
      pick: { order: [1n, 0n], occluded: [false, false], ambiguous: false },
    });
  });
});

describe('surface presentation', () => {
  const states: Presentation[] = [
    { kind: 'unbound', reason: { kind: 'released' } },
    { kind: 'unbound', reason: { kind: 'noBindingKey' } },
    { kind: 'binding' },
    { kind: 'ready' },
    { kind: 'presented' },
    { kind: 'hidden' },
    { kind: 'error' },
    { kind: 'detaching' },
    { kind: 'detached' },
  ];
  const reasons = ['noBindingKey', 'adapterUnavailable', 'unknownBindingKey', 'released'] as const;
  const events: SurfaceEvent[] = [
    ...reasons.map((kind): SurfaceEvent => ({ kind: 'bindingStarts', reason: { kind } })),
    ...(['bound', 'unknownKey', 'failed'] as const).map((kind): SurfaceEvent => ({
      kind: 'resolved',
      r: { kind },
    })),
    { kind: 'releaseStarts' },
    ...reasons.map((kind): SurfaceEvent => ({
      kind: 'releaseEnds',
      final: { kind: 'unbound', reason: { kind } },
    })),
    { kind: 'releaseEnds', final: { kind: 'detached' } },
    { kind: 'fails' },
    ...[false, true].flatMap((visible) =>
      [false, true].map((attached): SurfaceEvent => ({
        kind: 'attachmentsChanged',
        visible,
        attached,
      })),
    ),
    ...reasons.map((kind): SurfaceEvent => ({ kind: 'rebound', reason: { kind } })),
  ];

  it('announces a step exactly when its state changes or the handle fails', () => {
    for (const state of states) {
      for (const event of events) {
        const step = models.surfaceStep(state, event);
        const changed = JSON.stringify(step.next) !== JSON.stringify(state);
        expect(step.announce, `${JSON.stringify(state)} on ${JSON.stringify(event)}`).toBe(
          changed || event.kind === 'fails',
        );
      }
    }
  });

  it('does not announce binding again while binding, nor a release that ends where it was', () => {
    expect(
      models.surfaceStep(
        { kind: 'binding' },
        { kind: 'bindingStarts', reason: { kind: 'released' } },
      ).announce,
    ).toBe(false);
    expect(
      models.surfaceStep({ kind: 'detached' }, { kind: 'releaseEnds', final: { kind: 'detached' } })
        .announce,
    ).toBe(false);
    expect(models.surfaceStep({ kind: 'error' }, { kind: 'fails' }).announce).toBe(true);
  });
});

describe('backend handoff', () => {
  const underWay = ['preparing', 'validating', 'swapping'] as const;

  it('never begins a handoff while one is under way', () => {
    for (const kind of underWay) {
      expect(models.handoffStep({ kind }, { kind: 'begin' }), kind).toBeNull();
    }
    for (const kind of ['active', 'degraded'] as const) {
      expect(models.handoffStep({ kind }, { kind: 'begin' })).toEqual({ kind: 'preparing' });
    }
  });

  it('returns a failed handoff to the previous backend, active only when it still works', () => {
    for (const kind of underWay) {
      expect(models.handoffStep({ kind }, { kind: 'failed', oldUsable: true })).toEqual({
        kind: 'active',
      });
      expect(models.handoffStep({ kind }, { kind: 'failed', oldUsable: false })).toEqual({
        kind: 'degraded',
      });
    }
    expect(models.handoffStep({ kind: 'active' }, { kind: 'failed', oldUsable: true })).toBeNull();
  });

  it('opens a viewport with no backend, degraded, ready to begin its first handoff', () => {
    expect(models.viewportOpened()).toEqual({ kind: 'degraded' });
  });
});
