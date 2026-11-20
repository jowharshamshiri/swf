import { createWorkspace, SwfFailure } from '@swf/core';
import { createPresentationRegistry } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import type { Projection, ProjectionModule } from '../src/index.js';
import {
  createProjectionRegistry,
  equirectangular,
  validateProjectionModule,
} from '../src/index.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof SwfFailure
      ? `${error.error.code}: ${error.error.message}`
      : `not a SwfFailure: ${String(error)}`;
  }
  return 'accepted';
}

/** The reference module with some of its parts replaced. */
function variant(
  over: Partial<Record<keyof ProjectionModule, unknown>>,
  projection: Partial<Record<keyof Projection, unknown>> = {},
): ProjectionModule {
  const id = typeof over.id === 'string' ? over.id : 'variant/1';
  return {
    ...equirectangular,
    id,
    profile: { ...equirectangular.profile, id },
    create: (config) => {
      const base = equirectangular.create(config);
      const methods = {
        describeDomain: () => base.describeDomain(),
        projectDirection: base.projectDirection.bind(base),
        unprojectPoint: base.unprojectPoint.bind(base),
        projectGeometry: base.projectGeometry.bind(base),
        clipVisibility: base.clipVisibility.bind(base),
        interactionRay: base.interactionRay.bind(base),
      };
      return { id, ...methods, ...projection } as Projection;
    },
    ...over,
  } as ProjectionModule;
}

describe('projection validation (API-006)', () => {
  it('accepts the reference projection and a faithful variant of it', () => {
    expect(
      codeOf(() => {
        validateProjectionModule(equirectangular);
      }),
    ).toBe('accepted');
    expect(
      codeOf(() => {
        validateProjectionModule(variant({}));
      }),
    ).toBe('accepted');
  });

  it('rejects malformed modules as invalid input', () => {
    expect(
      codeOf(() => {
        validateProjectionModule(null as never);
      }),
    ).toMatch(/^INVALID_INPUT/);
    expect(
      codeOf(() => {
        validateProjectionModule(variant({ id: 'variant' }));
      }),
    ).toMatch(/^INVALID_INPUT: projection module ID/);
    expect(
      codeOf(() => {
        validateProjectionModule(variant({ create: undefined }));
      }),
    ).toMatch(/^INVALID_INPUT: .*create\(\)/);
    expect(
      codeOf(() => {
        validateProjectionModule(variant({ configIssue: 3 }));
      }),
    ).toMatch(/^INVALID_INPUT: .*configIssue\(\)/);
  });

  it('rejects another contract version, a bad profile or a domain that contradicts it', () => {
    const unsupported = (module: ProjectionModule, pattern: RegExp) => {
      const result = codeOf(() => {
        validateProjectionModule(module);
      });
      expect(result).toMatch(/^UNSUPPORTED_CAPABILITY/);
      expect(result).toMatch(pattern);
    };
    unsupported(variant({ apiVersion: 2 }), /contract version 2/);
    unsupported(
      variant({ profile: { ...equirectangular.profile, id: 'variant/1', mapping: 'curved' } }),
      /mapping/,
    );
    unsupported(variant({ profile: equirectangular.profile }), /profile ID "equirectangular\/1"/);
    unsupported(
      variant({ profile: { ...equirectangular.profile, id: 'variant/1', seamWrapping: false } }),
      /wraps at a seam but the profile/,
    );
    unsupported(
      variant({ profile: { ...equirectangular.profile, id: 'variant/1', exactInverse: false } }),
      /inverse is exact but the profile/,
    );
    const domain = equirectangular.create(equirectangular.defaultConfig).describeDomain();
    unsupported(
      variant({}, { describeDomain: () => ({ ...domain, nonInjective: false }) }),
      /non-injective/,
    );
    unsupported(
      variant({}, { describeDomain: () => ({ ...domain, maxInverseError: 0.1 }) }),
      /maxInverseError must be 0 exactly when/,
    );
    unsupported(
      variant({}, { describeDomain: () => ({ ...domain, fullCircle: false }) }),
      /fullCircle/,
    );
    unsupported(
      variant({}, { describeDomain: () => ({ ...domain, horizontalCoverage: 7 }) }),
      /horizontalCoverage/,
    );
    unsupported(
      variant({}, { describeDomain: () => ({ ...domain, inverse: 'perfect' }) }),
      /inverse must be/,
    );
  });

  it('rejects a projection that fails its probes, saying which', () => {
    const unsupported = (module: ProjectionModule, pattern: RegExp) => {
      const result = codeOf(() => {
        validateProjectionModule(module);
      });
      expect(result).toMatch(/^UNSUPPORTED_CAPABILITY/);
      expect(result).toMatch(pattern);
    };
    unsupported(
      variant({ defaultConfig: { horizontal: 999, vertical: 120 } }),
      /accept its default configuration: horizontal/,
    );
    unsupported(
      variant({
        create: () => {
          throw new Error('cannot');
        },
      }),
      /default configuration: cannot/,
    );
    unsupported(variant({}, { projectGeometry: undefined }), /without projectGeometry\(\)/);
    unsupported(variant({}, { id: 'other/1' }), /creates projections with ID "other\/1"/);
    unsupported(
      variant({}, { unprojectPoint: () => ({ kind: 'unpickable', reason: 'never' }) }),
      /centre is unpickable: never/,
    );
    unsupported(
      variant(
        {},
        { projectDirection: () => ({ images: [[0, 0]], singular: false, behind: false }) },
      ),
      /projects to \[\[0,0\]\], not back to \(200, 100\)/,
    );
  });
});

describe('projection registry', () => {
  const setup = () => {
    const ws = createWorkspace({ id: 'ws' });
    const presentation = createPresentationRegistry();
    const projections = createProjectionRegistry({
      kinds: ws.mutator(),
      projectors: presentation.registrar(),
    });
    return { ws, presentation, projections };
  };

  it('makes a projection usable by the scene and the host, and withdraws it from both', () => {
    const { ws, presentation, projections } = setup();
    const remove = projections.register(equirectangular);
    expect(projections.ids()).toEqual(['equirectangular/1']);
    expect(projections.get('equirectangular/1')).toBe(equirectangular);
    expect(presentation.projector('equirectangular/1')?.capabilities).toEqual(
      equirectangular.profile,
    );
    const viewport = {
      type: 'viewport.create',
      viewport: {
        cameraId: 'cam',
        projection: { id: 'equirectangular/1', config: { horizontal: 360, vertical: 180 } },
        size: { width: 10, height: 10, devicePixelRatio: 1 },
      },
    } as const;
    expect(
      ws.transaction([{ type: 'camera.create', camera: { id: 'cam' } }, viewport]).status,
    ).toBe('committed');
    // The scene checks configurations with the projection's own rules.
    const bad = ws.dispatch({
      ...viewport,
      viewport: {
        ...viewport.viewport,
        projection: { id: 'equirectangular/1', config: { horizontal: 360, vertical: 200 } },
      },
    });
    expect(bad.status === 'rejected' && bad.error.message).toMatch(/vertical must be/);
    remove();
    remove();
    expect(projections.ids()).toEqual([]);
    expect(presentation.projectorIds()).toEqual([]);
    expect(ws.dispatch(viewport).status).toBe('rejected');
    expect(codeOf(() => projections.register(equirectangular))).toBe('accepted');
  });

  it('rejects a second registration of an ID and leaves nothing half-registered', () => {
    const { ws, presentation, projections } = setup();
    projections.register(equirectangular);
    expect(codeOf(() => projections.register(equirectangular))).toMatch(
      /^INVALID_INPUT: .*already/,
    );
    // A kind the workspace already has blocks registration before any projector is added.
    ws.registerProjectionKind({ id: 'variant/1', configIssue: () => null });
    expect(codeOf(() => projections.register(variant({})))).toMatch(/^INVALID_INPUT/);
    expect(presentation.projectorIds()).toEqual(['equirectangular/1']);
    // A projector the host already has undoes the kind just added to the workspace.
    const other = variant({ id: 'other/1' });
    presentation.registerProjector({ profile: other.profile, project: () => [] });
    expect(codeOf(() => projections.register(other))).toMatch(/^INVALID_INPUT/);
    expect(codeOf(() => ws.registerProjectionKind(other))).toBe('accepted');
    expect(projections.ids()).toEqual(['equirectangular/1']);
  });
});
