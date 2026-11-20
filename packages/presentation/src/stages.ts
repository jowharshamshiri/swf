import type { Id, ResolvedGeometry, SceneState } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type { SurfaceCapabilities } from '@swf/surfaces';
import type {
  CompositorCapabilities,
  ProjectionProfile,
  RendererCapabilities,
} from './capabilities.js';
import type { PlannedFragment, RenderFrame } from './contracts.js';
import type { ProjectedFragment, ViewGeometry, ViewOutput } from './fragments.js';
import { viewGeometryIssue } from './fragments.js';
import type { FallbackDiagnostic, FallbackPolicy } from './negotiation.js';
import { DEFAULT_FALLBACK_POLICY, negotiate } from './negotiation.js';

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
 * Stage 4: computes a viewport's visible fragments for a scene. A projector reads the scene and
 * surface geometry only; it never changes either.
 */
export interface ViewProjector {
  readonly profile: ProjectionProfile;
  project(
    scene: SceneState,
    view: ViewGeometry,
    geometry: (surfaceId: Id) => ResolvedGeometry | undefined,
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
  /** The bound handle's capabilities for a surface, or null when it has none. */
  readonly surfaceCapabilities: (surfaceId: Id) => SurfaceCapabilities | null;
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
  const planned: PlannedFragment[] = output.fragments.map((fragment) => {
    const surface = input.surfaceCapabilities(fragment.surfaceId);
    const geometry = input.geometry(fragment.surfaceId);
    if (geometry === undefined) {
      return fail(`surface "${fragment.surfaceId}" has no geometry`);
    }
    const drawnEverywhere =
      surface?.attachStrategy === 'drawable' && surface.viewportSharing === 'shared';
    const owner =
      input.viewportOwns(fragment.surfaceId) && (fragment.nativeOwner || drawnEverywhere);
    const negotiation = negotiate(
      {
        surfaceId: fragment.surfaceId,
        viewportId: view.viewportId,
        surface,
        renderer: input.renderer,
        compositor: input.compositor,
        projection: input.projection,
        geometry: {
          kind: geometry.kind,
          supported: geometry.supported,
          fidelity: geometry.fidelity,
        },
        anchor: fragment.geometricFidelity,
        owner,
      },
      input.policy ?? DEFAULT_FALLBACK_POLICY,
    );
    return Object.freeze({ fragment, negotiation });
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
