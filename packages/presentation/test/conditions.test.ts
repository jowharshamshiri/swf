import { mockCapabilities } from '@swf/conformance';
import { makeError } from '@swf/core';
import type { SurfacePresentation } from '@swf/surfaces';
import { describe, expect, it } from 'vitest';
import type { Negotiation, PlannedFragment } from '../src/index.js';
import { conditionFor, STAND_IN_REASONS, standInReason, surfaceCondition } from '../src/index.js';

const presentation = (over: Partial<SurfacePresentation>): SurfacePresentation => ({
  surfaceId: 's',
  state: 'unbound',
  generation: 1,
  binding: { bindingKey: 'k', adapterTypeId: 'test/1' },
  capabilities: null,
  unboundReason: null,
  error: null,
  viewports: [],
  replacing: false,
  ...over,
});

const planned = (
  condition: PlannedFragment['condition'],
  mode: Negotiation['mode'] = 'placeholder',
  representation: PlannedFragment['representation'] = 'full',
): PlannedFragment =>
  ({
    fragment: { surfaceId: 's' },
    negotiation: { mode },
    representation,
    condition,
  }) as PlannedFragment;

describe('surface conditions (FR-195)', () => {
  it('follows the runtime: bound, pending, unbound by its reason, unsupported and failed', () => {
    const capabilities = mockCapabilities();
    expect(surfaceCondition(undefined, false)).toEqual({ kind: 'pending' });
    for (const state of ['ready', 'presented', 'hidden'] as const) {
      expect(surfaceCondition(presentation({ state, capabilities }), false)).toEqual({
        kind: 'bound',
        capabilities,
        presentedElsewhere: false,
      });
    }
    for (const state of ['binding', 'detaching'] as const) {
      expect(surfaceCondition(presentation({ state }), false)).toEqual({ kind: 'pending' });
    }
    expect(surfaceCondition(presentation({ state: 'detached' }), false)).toEqual({
      kind: 'unbound',
      reason: 'released',
    });
    for (const reason of ['no-binding-key', 'unknown-binding-key', 'released'] as const) {
      expect(surfaceCondition(presentation({ unboundReason: reason }), false)).toEqual({
        kind: 'unbound',
        reason,
      });
    }
    expect(surfaceCondition(presentation({ unboundReason: 'adapter-unavailable' }), false)).toEqual(
      { kind: 'unsupported' },
    );
    const error = makeError('BIND_FAILED', 'attach threw', { retryable: true });
    expect(surfaceCondition(presentation({ state: 'error', error }), false)).toEqual({
      kind: 'failed',
      error,
    });
  });

  it('counts a handle as shown elsewhere only when it is single-owner', () => {
    const single = mockCapabilities({ viewportSharing: 'single-owner' });
    const shared = mockCapabilities({ viewportSharing: 'shared' });
    expect(surfaceCondition(presentation({ state: 'ready', capabilities: single }), true)).toEqual({
      kind: 'bound',
      capabilities: single,
      presentedElsewhere: true,
    });
    expect(
      surfaceCondition(presentation({ state: 'ready', capabilities: shared }), true),
    ).toMatchObject({ presentedElsewhere: false });
    expect(conditionFor(single, true)).toMatchObject({ presentedElsewhere: true });
    expect(conditionFor(shared, true)).toMatchObject({ presentedElsewhere: false });
    expect(conditionFor(null)).toEqual({ kind: 'unbound', reason: 'no-binding-key' });
  });

  it('refuses a runtime that reports a bound surface without capabilities or an error without one', () => {
    expect(() => surfaceCondition(presentation({ state: 'ready' }), false)).toThrow(
      /bound without capabilities/,
    );
    expect(() => surfaceCondition(presentation({ state: 'error' }), false)).toThrow(
      /in error without an error/,
    );
  });
});

describe('stand-in reasons (FR-195)', () => {
  it('gives every stand-in for an unbound, unsupported, pending or failed surface its reason', () => {
    expect(standInReason(planned({ kind: 'pending' }))).toBe('pending');
    expect(standInReason(planned({ kind: 'unbound', reason: 'released' }))).toBe('unbound');
    expect(standInReason(planned({ kind: 'unsupported' }))).toBe('unsupported');
    const retryable = makeError('BIND_FAILED', 'timed out', { retryable: true });
    const final = makeError('UNSUPPORTED_CAPABILITY', 'cannot', { retryable: false });
    expect(standInReason(planned({ kind: 'failed', error: retryable }))).toBe('unavailable');
    expect(standInReason(planned({ kind: 'failed', error: final }))).toBe('failed');
  });

  it('gives a bound surface a reason only when it is shown elsewhere or cannot be shown here', () => {
    const capabilities = mockCapabilities();
    const bound = { kind: 'bound', capabilities, presentedElsewhere: false } as const;
    expect(standInReason(planned(bound, 'native'))).toBeNull();
    // A seam's secondary proxy, or a representation, needs no reason: the view shows it.
    expect(standInReason(planned(bound, 'proxy'))).toBeNull();
    expect(standInReason(planned(bound, 'placeholder', 'label'))).toBeNull();
    // A placeholder of a full representation: this backend cannot present what it is.
    expect(standInReason(planned(bound))).toBe('unsupported');
    expect(standInReason(planned({ ...bound, presentedElsewhere: true }, 'proxy'))).toBe(
      'elsewhere',
    );
    // Shown elsewhere, but represented here by choice: the representation is the reason.
    expect(
      standInReason(planned({ ...bound, presentedElsewhere: true }, 'proxy', 'compact')),
    ).toBeNull();
    expect(
      standInReason(planned({ ...bound, presentedElsewhere: true }, 'proxy', 'label')),
    ).toBeNull();
    expect(STAND_IN_REASONS).toHaveLength(6);
  });
});
