import type { Id, ResolvedGeometry, SceneState } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type { SurfaceCondition } from './conditions.js';
import type {
  CompositorCapabilities,
  ProjectionProfile,
  RendererCapabilities,
} from './capabilities.js';
import type { PlannedFragment, RenderFrame } from './contracts.js';
import type { ProjectedFragment, ViewGeometry, ViewOutput } from './fragments.js';
import { viewGeometryIssue } from './fragments.js';
import type { FallbackDiagnostic, FallbackPolicy } from './negotiation.js';
import { DEFAULT_FALLBACK_POLICY, negotiateFragments } from './negotiation.js';
import type { Representation, RepresentationPolicy } from './representation.js';
import { representationFor } from './representation.js';

/**
 * The stages that turn a scene change into a presented frame, in order, and the contract that
 * carries each. Interaction previews may take a shorter path through them.
 */
export const PRESENTATION_STAGES = Object.freeze([
  { stage: 1, name: 'ingest', contract: 'Workspace.transaction: commands are validated' },
  { stage: 2, name: 'commit', contract: 'Workspace: one revision is committed' },
  {
    stage: 3,
    name: 'resolve',
    contract: 'Workspace: constraints are resolved; effectiveState gives inherited flags',
  },
  {
    stage: 4,
    name: 'project',
    contract: 'ViewProjector.project, then createViewOutput: visible candidates as fragments',
  },
  { stage: 5, name: 'hint', contract: 'SurfaceRuntime.deliverHint: advisory adapter hints' },
  { stage: 6, name: 'plan', contract: 'planFrame: negotiation per fragment into a RenderFrame' },
  {
    stage: 7,
    name: 'realize',
    contract: 'RendererSession.render, then CompositorSession.compose',
  },
  { stage: 8, name: 'publish', contract: 'frame metrics are published' },
] as const);

/**
 * What a projector made for a view in the frame before: the scene it projected and the fragments
 * it gave, for the very same view geometry.
 */
export interface PreviousProjection {
  readonly scene: SceneState;
  readonly fragments: readonly ProjectedFragment[];
}

/**
 * Stage 4: computes a viewport's visible fragments for a scene. A projector reads the scene and
 * surface geometry only; it never changes either.
 */
export interface ViewProjector {
  readonly profile: ProjectionProfile;
  /**
   * The fragments of every visible surface, in the scene's surface order. With `previous` (given
   * only when the view geometry is unchanged since that projection), a projector may keep the
   * fragments of each surface whose placement did not change, projecting only the rest; what it
   * returns must equal a projection made afresh (NFR-005, NFR-020).
   */
  project(
    scene: SceneState,
    view: ViewGeometry,
    geometry: (surfaceId: Id) => ResolvedGeometry | undefined,
    previous?: PreviousProjection,
  ): ProjectedFragment[];
}

/** What stage 6 needs to plan a frame. */
export interface FrameInput {
  readonly scene: SceneState;
  readonly view: ViewGeometry;
  readonly output: ViewOutput;
  readonly renderer: { readonly id: string; readonly capabilities: RendererCapabilities };
  readonly compositor: { readonly id: string; readonly capabilities: CompositorCapabilities };
  readonly projection: ProjectionProfile;
  readonly policy?: FallbackPolicy;
  /** How each surface is represented here; with none, every surface is `full`. */
  readonly representation?: RepresentationPolicy;
  /** Where each surface's binding stands; a bound one carries its handle's capabilities. */
  readonly condition: (surfaceId: Id) => SurfaceCondition;
  /**
   * Whether this viewport may hold the surface's live handle: false when a single-owner handle is
   * presented in another viewport.
   */
  readonly viewportOwns: (surfaceId: Id) => boolean;
  readonly geometry: (surfaceId: Id) => ResolvedGeometry | undefined;
}

/**
 * Stage 6: negotiates the presentation of every fragment and assembles the frame. Only a
 * surface's native-owner fragment can hold a live native element; its other fragments become
 * proxies routing to the same surface. Drawable content that the adapter declares shareable can
 * be drawn in every fragment. Throws {@link SwfFailure} (`INVALID_INPUT`) when the inputs disagree.
 */
export function planFrame(input: FrameInput): RenderFrame {
  const { scene, view, output } = input;
  const fail = (message: string): never => {
    throw new SwfFailure(
      makeError('INVALID_INPUT', `frame for viewport "${view.viewportId}": ${message}`, {
        workspaceId: scene.workspaceId,
      }),
    );
  };
  const issue = viewGeometryIssue(view);
  if (issue !== null) {
    fail(issue);
  }
  if (output.viewportId !== view.viewportId) {
    fail(`the view output belongs to viewport "${output.viewportId}"`);
  }
  if (output.sceneRevision !== scene.revision) {
    fail(
      `the view output is for revision ${String(output.sceneRevision)}, not ${String(scene.revision)}`,
    );
  }
  if (view.projectionId !== input.projection.id) {
    fail(`the view uses projection "${view.projectionId}", not "${input.projection.id}"`);
  }
  // Every fragment of a surface is represented alike: the policy is asked once per surface.
  const representations = new Map<Id, Representation>();
  const representationOf = (surfaceId: Id): Representation => {
    const known = representations.get(surfaceId);
    if (known !== undefined) {
      return known;
    }
    const policy = input.representation;
    const nodeId = scene.surfaces.get(surfaceId)?.ownerNodeId;
    if (nodeId === undefined) {
      return fail(`surface "${surfaceId}" is not in the scene`);
    }
    const chosen =
      policy === undefined ? 'full' : representationFor(policy, { scene, view, surfaceId, nodeId });
    representations.set(surfaceId, chosen);
    return chosen;
  };
  const facts = output.fragments.map((fragment) => {
    const condition = input.condition(fragment.surfaceId);
    const geometry = input.geometry(fragment.surfaceId);
    if (geometry === undefined) {
      return fail(`surface "${fragment.surfaceId}" has no geometry`);
    }
    return {
      fragment,
      condition,
      representation: representationOf(fragment.surfaceId),
      negotiation: {
        surfaceId: fragment.surfaceId,
        surface: condition.kind === 'bound' ? condition.capabilities : null,
        geometry: {
          kind: geometry.kind,
          supported: geometry.supported,
          fidelity: geometry.fidelity,
        },
        anchor: fragment.geometricFidelity,
        owner: input.viewportOwns(fragment.surfaceId),
        nativeOwner: fragment.nativeOwner,
      },
    };
  });
  // Every fragment of the frame in one negotiation.
  const negotiations = negotiateFragments(
    {
      viewportId: view.viewportId,
      renderer: input.renderer,
      compositor: input.compositor,
      projection: input.projection,
    },
    facts.map((f) => ({ ...f.negotiation, represented: f.representation !== 'full' })),
    input.policy ?? DEFAULT_FALLBACK_POLICY,
  );
  const planned: PlannedFragment[] = facts.map(({ fragment, condition, representation }, i) => {
    const negotiation = negotiations[i];
    if (negotiation === undefined) {
      throw new Error(`the fallback model left fragment ${String(i)} unanswered`);
    }
    return Object.freeze({ fragment, negotiation, representation, condition });
  });
  return Object.freeze({
    viewportId: view.viewportId,
    sceneRevision: scene.revision,
    scene,
    view,
    output,
    planned: Object.freeze(planned),
    fallbacks: Object.freeze(
      planned.flatMap((p) => (p.negotiation.fallback === null ? [] : [p.negotiation.fallback])),
    ),
  });
}

/**
 * Fallback diagnostics grouped by their `groupKey`, so identical fallbacks (the same backends,
 * kind of endpoint, outcome and reasons) are reported once with a count, in first-seen order.
 */
export function groupFallbacks(fallbacks: readonly FallbackDiagnostic[]): {
  readonly example: FallbackDiagnostic;
  readonly count: number;
  readonly surfaceIds: readonly Id[];
}[] {
  const groups = new Map<
    string,
    { example: FallbackDiagnostic; count: number; surfaceIds: Id[] }
  >();
  for (const fallback of fallbacks) {
    const group = groups.get(fallback.groupKey);
    if (group === undefined) {
      groups.set(fallback.groupKey, {
        example: fallback,
        count: 1,
        surfaceIds: [fallback.surfaceId],
      });
    } else {
      group.count += 1;
      if (!group.surfaceIds.includes(fallback.surfaceId)) {
        group.surfaceIds.push(fallback.surfaceId);
      }
    }
  }
  return [...groups.values()];
}
