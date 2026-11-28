import {
  MOCK_COMPOSITOR_CAPABILITIES,
  MOCK_RENDERER_CAPABILITIES,
  mockCapabilities,
} from '@swf/conformance';
import type { SceneCommand, Workspace } from '@swf/core';
import { createWorkspace, SwfFailure } from '@swf/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type {
  ProjectedFragment,
  ProjectionProfile,
  Representation,
  RepresentationPolicy,
  ViewGeometry,
} from '../src/index.js';
import {
  conditionFor,
  createViewOutput,
  fragmentId,
  groupFallbacks,
  planFrame,
  representationFor,
} from '../src/index.js';

const PANORAMA: ProjectionProfile = {
  id: 'test.panorama/1',
  seamWrapping: true,
  exactInverse: true,
};
const PERSPECTIVE: ProjectionProfile = {
  id: 'test.perspective/1',
  seamWrapping: false,
  exactInverse: true,
};

function workspace(): Workspace {
  const ws = createWorkspace({ id: 'ws' });
  const commands: SceneCommand[] = [
    { type: 'node.create', node: { id: 'back', kind: 'window', bounds: [2, 1, 0.01] } },
    {
      type: 'node.create',
      node: {
        id: 'front',
        kind: 'window',
        bounds: [2, 1, 0.01],
        flags: { presentationPriority: 5 },
      },
    },
    ...['a', 'b'].map((id): SceneCommand => ({
      type: 'surface.attach',
      surface: {
        id,
        ownerNodeId: 'back',
        bindingKey: `k-${id}`,
        adapterTypeId: 'test.view/1',
        bounds: [1, 1, 0.01],
      },
    })),
    {
      type: 'surface.attach',
      surface: {
        id: 'c',
        ownerNodeId: 'front',
        bindingKey: 'k-c',
        adapterTypeId: 'test.view/1',
        bounds: [1, 1, 0.01],
      },
    },
  ];
  const result = ws.transaction(commands);
  if (result.status !== 'committed') {
    throw new Error('fixture failed');
  }
  return ws;
}

function fragment(
  surfaceId: string,
  ordinal: number,
  over: Partial<ProjectedFragment> = {},
): ProjectedFragment {
  return {
    id: fragmentId('v', surfaceId, ordinal),
    surfaceId,
    viewportId: 'v',
    ordinal,
    bounds: [0, 0, 10, 10],
    card: [0, 0, 10, 10],
    scale: 1,
    representation: 'full',
    depth: 3,
    geometricFidelity: 'exact',
    nativeOwner: ordinal === 0,
    front: false,
    ...over,
  };
}

const VIEW = (profile: ProjectionProfile): ViewGeometry => ({
  viewportId: 'v',
  width: 800,
  height: 600,
  devicePixelRatio: 2,
  camera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  near: 0.05,
  far: null,
  projectionId: profile.id,
  projectionConfig: null,
});

describe('presentation fragment IDs', () => {
  it('keep apart IDs that differ only in where a separator falls', () => {
    expect(fragmentId('a/b', 'c', 0)).not.toBe(fragmentId('a', 'b/c', 0));
    expect(fragmentId('v', 's/0', 1)).not.toBe(fragmentId('v/s', '0', 1));
    expect(fragmentId('v%2Fs', 'x', 0)).not.toBe(fragmentId('v/s', 'x', 0));
  });

  it('never collide, even when IDs contain separators', () => {
    const part = fc.string({
      minLength: 1,
      maxLength: 6,
      unit: fc.constantFrom('a', '/', '%', ':', '#', 'b'),
    });
    fc.assert(
      fc.property(part, part, fc.nat(3), part, part, fc.nat(3), (v1, s1, o1, v2, s2, o2) => {
        const same = v1 === v2 && s1 === s2 && o1 === o2;
        expect(fragmentId(v1, s1, o1) === fragmentId(v2, s2, o2)).toBe(same);
      }),
      { numRuns: 3000 },
    );
  });
});

describe('view output', () => {
  it('maps every fragment to its one surface, several fragments sharing it', () => {
    const ws = workspace();
    const output = createViewOutput(ws.getState(), 'v', [
      fragment('a', 0),
      fragment('a', 1),
      fragment('c', 0),
    ]);
    expect(output.surfaceOf(fragmentId('v', 'a', 1))).toBe('a');
    expect(output.surfaceOf('nope')).toBeUndefined();
    expect(output.fragmentsOf('a').map((f) => f.ordinal)).toEqual([0, 1]);
    expect(output.fragmentsOf('b')).toEqual([]);
    expect(Object.isFrozen(output.fragments)).toBe(true);
  });

  it('orders back to front by depth, then priority, then scene order, never by supply order', () => {
    const ws = workspace();
    const all = [
      fragment('a', 0, { depth: 3 }),
      fragment('b', 0, { depth: 3 }),
      fragment('c', 0, { depth: 3 }),
      fragment('a', 1, { depth: 9 }),
    ];
    const order = (list: readonly ProjectedFragment[]) =>
      createViewOutput(ws.getState(), 'v', list).fragments.map((f) => f.id);
    const expected = [
      fragmentId('v', 'a', 1),
      fragmentId('v', 'a', 0),
      fragmentId('v', 'b', 0),
      fragmentId('v', 'c', 0),
    ];
    expect(order(all)).toEqual(expected);
    fc.assert(
      fc.property(fc.shuffledSubarray(all, { minLength: all.length }), (shuffled) => {
        expect(order(shuffled)).toEqual(expected);
      }),
    );
  });

  it('rejects inconsistent fragments, naming the problem', () => {
    const state = workspace().getState();
    const bad = (list: ProjectedFragment[]) => {
      try {
        createViewOutput(state, 'v', list);
      } catch (error) {
        return error instanceof SwfFailure ? error.error.message : String(error);
      }
      return 'accepted';
    };
    expect(bad([fragment('a', 0, { viewportId: 'w' })])).toMatch(/belongs to viewport "w"/);
    expect(bad([{ ...fragment('a', 0), id: 'custom' }])).toMatch(/not the ID derived/);
    expect(bad([fragment('a', 0), fragment('a', 0)])).toMatch(/appears twice/);
    expect(bad([fragment('a', 1)])).toMatch(/ordinals 1, not 0 to 0/);
    expect(bad([fragment('a', 0), fragment('a', 1, { nativeOwner: true })])).toMatch(
      /more than one native-owner/,
    );
    expect(bad([fragment('zz', 0)])).toMatch(/unknown surface "zz"/);
    expect(bad([fragment('a', 0, { bounds: [0, 0, -1, 1] })])).toMatch(/invalid bounds/);
    expect(bad([fragment('a', 0, { depth: NaN })])).toMatch(/non-finite depth/);
  });
});

describe('frame planning', () => {
  const plan = (
    profile: ProjectionProfile,
    owns: (id: string) => boolean = () => true,
    representation?: RepresentationPolicy,
    compositor = MOCK_COMPOSITOR_CAPABILITIES,
    // How exactly a's card places it: approximately for a window carrying a rotation of its own.
    placedA: 'exact' | 'approximate' = 'exact',
  ) => {
    const ws = workspace();
    const state = ws.getState();
    const view = VIEW(profile);
    // As a projector does: the policy is asked once per surface, and every fragment of the
    // surface is represented alike.
    const chosen = new Map<string, Representation>();
    const shown = (surfaceId: string): Representation => {
      const nodeId = state.surfaces.get(surfaceId)?.ownerNodeId ?? '';
      const known = chosen.get(surfaceId);
      const answer =
        known ??
        (representation === undefined
          ? 'full'
          : representationFor(representation, { scene: state, view, surfaceId, nodeId }));
      chosen.set(surfaceId, answer);
      return answer;
    };
    return planFrame({
      scene: state,
      view,
      output: createViewOutput(state, 'v', [
        fragment('a', 0, { representation: shown('a'), geometricFidelity: placedA }),
        fragment('a', 1, { representation: shown('a'), geometricFidelity: placedA }),
        fragment('b', 0, { representation: shown('b') }),
        fragment('c', 0, { representation: shown('c') }),
      ]),
      renderer: { id: 'r/1', capabilities: MOCK_RENDERER_CAPABILITIES },
      compositor: { id: 'c/1', capabilities: compositor },
      projection: profile,
      condition: (id) =>
        conditionFor(
          id === 'b'
            ? mockCapabilities({
                attachStrategy: 'drawable',
                nativeInteraction: 'none',
                transformFidelity: 'exact',
                viewportSharing: 'shared',
              })
            : id === 'c'
              ? null
              : mockCapabilities(),
        ),
      viewportOwns: owns,
      geometry: (id) => ws.surfaceGeometry(id),
    });
  };
  const modes = (frame: ReturnType<typeof plan>) =>
    Object.fromEntries(frame.planned.map((p) => [p.fragment.id, p.negotiation.mode]));

  it('gives the live element to the native-owner fragment and proxies its seam duplicate', () => {
    const frame = plan(PERSPECTIVE);
    expect(modes(frame)).toEqual({
      [fragmentId('v', 'a', 0)]: 'native',
      [fragmentId('v', 'a', 1)]: 'proxy',
      [fragmentId('v', 'b', 0)]: 'exact',
      [fragmentId('v', 'c', 0)]: 'placeholder',
    });
    expect(frame.planned.map((p) => p.fragment.id)).toEqual(
      frame.output.fragments.map((f) => f.id),
    );
    expect(frame.fallbacks.map((f) => f.surfaceId)).toEqual(['a', 'a', 'c']);
  });

  it('presents the live element natively in a panorama, approximates it where its card only approximates its place, and proxies it where another viewport owns it', () => {
    expect(modes(plan(PANORAMA))[fragmentId('v', 'a', 0)]).toBe('native');
    const turned = plan(
      PANORAMA,
      () => true,
      undefined,
      MOCK_COMPOSITOR_CAPABILITIES,
      'approximate',
    );
    expect(modes(turned)[fragmentId('v', 'a', 0)]).toBe('approximated');
    expect(modes(plan(PERSPECTIVE, (id) => id !== 'a'))[fragmentId('v', 'a', 0)]).toBe('proxy');
  });

  it('represents surfaces as the representation policy chooses, never as a fallback (FR-122, ARCH-025)', () => {
    const asked: string[] = [];
    const policy: RepresentationPolicy = {
      id: 'test.depth/1',
      representationOf({ surfaceId, nodeId }) {
        asked.push(`${surfaceId}@${nodeId}`);
        return surfaceId === 'a' ? 'compact' : surfaceId === 'b' ? 'label' : 'full';
      },
    };
    const frame = plan(PERSPECTIVE, () => true, policy);
    const of = (id: string) => frame.planned.find((p) => p.fragment.id === id);
    // Both fragments of a stand for it compactly: a proxy, the live element left unmounted.
    for (const id of [fragmentId('v', 'a', 0), fragmentId('v', 'a', 1)]) {
      expect(of(id)?.representation).toBe('compact');
      expect(of(id)?.negotiation.mode).toBe('proxy');
    }
    // b could be drawn exactly; its label stands for it instead.
    expect(of(fragmentId('v', 'b', 0))).toMatchObject({
      representation: 'label',
      negotiation: { mode: 'proxy', layer: 'proxy' },
    });
    expect(of(fragmentId('v', 'c', 0))?.representation).toBe('full');
    // A representation chosen is not a fallback: only c, which has no handle, falls back.
    expect(frame.fallbacks.map((f) => f.surfaceId)).toEqual(['c']);
    // The policy is asked once per surface, with the node that owns it.
    expect(asked).toEqual(['a@back', 'b@back', 'c@front']);
    // Without a policy every surface is shown in full.
    expect(plan(PERSPECTIVE).planned.every((p) => p.representation === 'full')).toBe(true);
  });

  it('falls back to a placeholder for a represented surface only when no proxy is possible', () => {
    const noProxy = {
      ...MOCK_COMPOSITOR_CAPABILITIES,
      layerCategories: MOCK_COMPOSITOR_CAPABILITIES.layerCategories.filter((c) => c !== 'proxy'),
    };
    const frame = plan(
      PERSPECTIVE,
      () => true,
      { id: 'test.depth/1', representationOf: () => 'compact' },
      noProxy,
    );
    const b = frame.planned.find((p) => p.fragment.surfaceId === 'b');
    expect(b?.negotiation.mode).toBe('placeholder');
    expect(b?.negotiation.fallback).toMatchObject({
      preferred: 'proxy',
      chosen: 'placeholder',
      gaps: [{ mode: 'proxy', requirement: 'compositor' }],
    });
  });

  it('refuses a representation policy that answers something that is no representation', () => {
    const bad = {
      id: 'test.depth/1',
      representationOf: () => 'tiny',
    } as unknown as RepresentationPolicy;
    expect(() => plan(PERSPECTIVE, () => true, bad)).toThrow(
      /representation policy "test.depth\/1" answered "tiny" for surface "a"/,
    );
    // Nor does a view output hold a fragment represented so.
    const state = workspace().getState();
    expect(() =>
      createViewOutput(state, 'v', [
        fragment('a', 0, { representation: 'tiny' as unknown as Representation }),
      ]),
    ).toThrow(/has representation "tiny", not one of full, compact, label/);
  });

  it('groups identical fallbacks with a count', () => {
    const groups = groupFallbacks(
      plan(PANORAMA, () => true, undefined, MOCK_COMPOSITOR_CAPABILITIES, 'approximate').fallbacks,
    );
    expect(groups.map((g) => [g.example.chosen, g.count, g.surfaceIds])).toEqual([
      ['approximated', 1, ['a']],
      ['proxy', 1, ['a']],
      ['placeholder', 1, ['c']],
    ]);
  });

  it('rejects inputs that disagree', () => {
    const ws = workspace();
    const state = ws.getState();
    const base = {
      scene: state,
      view: VIEW(PERSPECTIVE),
      output: createViewOutput(state, 'v', []),
      renderer: { id: 'r/1', capabilities: MOCK_RENDERER_CAPABILITIES },
      compositor: { id: 'c/1', capabilities: MOCK_COMPOSITOR_CAPABILITIES },
      projection: PERSPECTIVE,
      condition: () => conditionFor(null),
      viewportOwns: () => true,
      geometry: (id: string) => ws.surfaceGeometry(id),
    };
    expect(() => planFrame({ ...base, projection: PANORAMA })).toThrow(/uses projection/);
    expect(() => planFrame({ ...base, view: { ...VIEW(PERSPECTIVE), viewportId: 'x' } })).toThrow(
      /belongs to viewport/,
    );
    expect(() => planFrame({ ...base, view: { ...VIEW(PERSPECTIVE), width: 0 } })).toThrow(
      /width and height/,
    );
    expect(() => planFrame({ ...base, view: { ...VIEW(PERSPECTIVE), near: 0 } })).toThrow(
      /near must be/,
    );
    expect(() => planFrame({ ...base, view: { ...VIEW(PERSPECTIVE), far: 0.01 } })).toThrow(
      /far must be null or/,
    );
    expect(() =>
      planFrame({ ...base, view: { ...VIEW(PERSPECTIVE), far: Number.POSITIVE_INFINITY } }),
    ).toThrow(/far must be null or/);
    ws.dispatch({ type: 'surface.patch', id: 'a', label: 'later' });
    expect(() => planFrame({ ...base, scene: ws.getState() })).toThrow(/is for revision 1, not 2/);
  });
});
