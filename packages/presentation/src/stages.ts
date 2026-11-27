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
import type { RepresentationPolicy } from './representation.js';

/**
 * The stages that turn a scene change into a presented frame, in order, and the contract that
 * carries each. Interaction previews may take a shorter path through them. The presenter runs
 * stages 4 to 8 for each viewport frame: it projects, plans, renders and composes, attaches what
 * is live, then delivers the hints once the attachments have settled, and publishes the frame's
 * metrics last. The list and each entry are frozen.
 */
export const PRESENTATION_STAGES = Object.freeze([
  {
    /** Its place in the order, from 1. */
    stage: 1,
    /** Its short name. */
    name: 'ingest',
    /** The interface that carries it, and what it guarantees. */
    contract: 'Workspace.transaction: commands are validated',
  },
  {
    /** Its place in the order, from 1. */
    stage: 2,
    /** Its short name. */
    name: 'commit',
    /** The interface that carries it, and what it guarantees. */
    contract: 'Workspace: one revision is committed',
  },
  {
    /** Its place in the order, from 1. */
    stage: 3,
    /** Its short name. */
    name: 'resolve',
    /** The interface that carries it, and what it guarantees. */
    contract: 'Workspace: constraints are resolved; effectiveState gives inherited flags',
  },
  {
    /** Its place in the order, from 1. */
    stage: 4,
    /** Its short name. */
    name: 'project',
    /** The interface that carries it, and what it guarantees. */
    contract: 'ViewProjector.project, then createViewOutput: visible candidates as fragments',
  },
  {
    /** Its place in the order, from 1. */
    stage: 5,
    /** Its short name. */
    name: 'hint',
    /** The interface that carries it, and what it guarantees. */
    contract: 'SurfaceRuntime.deliverHint: advisory adapter hints',
  },
  {
    /** Its place in the order, from 1. */
    stage: 6,
    /** Its short name. */
    name: 'plan',
    /** The interface that carries it, and what it guarantees. */
    contract: 'planFrame: negotiation per fragment into a RenderFrame',
  },
  {
    /** Its place in the order, from 1. */
    stage: 7,
    /** Its short name. */
    name: 'realize',
    /** The interface that carries it, and what it guarantees. */
    contract: 'RendererSession.render, then CompositorSession.compose',
  },
  {
    /** Its place in the order, from 1. */
    stage: 8,
    /** Its short name. */
    name: 'publish',
    /** The interface that carries it, and what it guarantees. */
    contract: 'frame metrics are published',
  },
] as const);

/**
 * Stage 4: computes a viewport's visible fragments for a scene, each surface on its window's card
 * (the card rules, `CARD_PIXELS_PER_UNIT`). A projector reads the scene, the surfaces'
 * geometry and the representation policy only; it never changes any of them.
 */
export interface ViewProjector {
  /**
   * The profile of the projection it places fragments with; its `id` is the projection ID it is
   * registered under and that views name.
   */
  readonly profile: ProjectionProfile;
  /**
   * The fragments of every visible surface, in the scene's surface order. `representation` chooses
   * how each surface is shown (asked once per surface), and with it the size of its card; with
   * null, every surface is shown in full and its card scaled by its distance alone.
   */
  project(
    scene: SceneState,
    view: ViewGeometry,
    geometry: (surfaceId: Id) => ResolvedGeometry | undefined,
    representation: RepresentationPolicy | null,
  ): ProjectedFragment[];
}

/** What stage 6 needs to plan a frame. */
export interface FrameInput {
  /** The scene the frame shows; every surface of `output` must be in it. */
  readonly scene: SceneState;
  /** The view; it must pass {@link viewGeometryIssue} and name `projection`'s ID. */
  readonly view: ViewGeometry;
  /** The view's fragments for `scene`, from the same viewport and revision. */
  readonly output: ViewOutput;
  /** The viewport's renderer. */
  readonly renderer: {
    /** Its versioned ID. */
    readonly id: string;
    /** What it declared, as registration validated it. */
    readonly capabilities: RendererCapabilities;
  };
  /** The viewport's compositor. */
  readonly compositor: {
    /** Its versioned ID. */
    readonly id: string;
    /** What it declared, as registration validated it. */
    readonly capabilities: CompositorCapabilities;
  };
  /** The profile of the view's projection. */
  readonly projection: ProjectionProfile;
  /** The fallback order; default {@link DEFAULT_FALLBACK_POLICY}. */
  readonly policy?: FallbackPolicy;
  /** Where each surface's binding stands; a bound one carries its handle's capabilities. */
  readonly condition: (surfaceId: Id) => SurfaceCondition;
  /**
   * Whether this viewport may hold the surface's live handle: false when a single-owner handle is
   * presented in another viewport.
   */
  readonly viewportOwns: (surfaceId: Id) => boolean;
  /** Each surface's geometry as placed in `scene`; a surface of `output` without one is refused. */
  readonly geometry: (surfaceId: Id) => ResolvedGeometry | undefined;
}

/**
 * Stage 6: negotiates the presentation of every fragment and assembles the frame. Only a
 * surface's native-owner fragment can hold a live native element; its other fragments become
 * proxies routing to the same surface. Drawable content that the adapter declares shareable can
 * be drawn in every fragment. Throws {@link SwfFailure} (`INVALID_INPUT`) when the inputs disagree:
 * an invalid view, an output of another viewport or revision, a view naming another projection,
 * or a fragment whose surface is not in the scene or has no geometry. Each fragment is represented
 * as its projector chose. The frame returned is frozen and refers to the inputs as given.
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
  const facts = output.fragments.map((fragment) => {
    const condition = input.condition(fragment.surfaceId);
    const geometry = input.geometry(fragment.surfaceId);
    if (geometry === undefined) {
      return fail(`surface "${fragment.surfaceId}" has no geometry`);
    }
    return {
      fragment,
      condition,
      representation: fragment.representation,
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
  /** The group's first fallback. */
  readonly example: FallbackDiagnostic;
  /** How many fallbacks the group holds, repeats of a surface included. */
  readonly count: number;
  /** The surfaces of the group, each once, in first-seen order. */
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
