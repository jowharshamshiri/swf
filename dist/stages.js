import { makeError, SwfFailure } from '@swf/core';
import { viewGeometryIssue } from './fragments.js';
import { DEFAULT_FALLBACK_POLICY, negotiateFragments } from './negotiation.js';
import { representationFor } from './representation.js';
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
]);
/**
 * Stage 6: negotiates the presentation of every fragment and assembles the frame. Only a
 * surface's native-owner fragment can hold a live native element; its other fragments become
 * proxies routing to the same surface. Drawable content that the adapter declares shareable can
 * be drawn in every fragment. Throws {@link SwfFailure} (`INVALID_INPUT`) when the inputs disagree:
 * an invalid view, an output of another viewport or revision, a view naming another projection,
 * or a fragment whose surface is not in the scene or has no geometry. The representation policy
 * is asked once per surface. The frame returned is frozen and refers to the inputs as given.
 */
export function planFrame(input) {
    const { scene, view, output } = input;
    const fail = (message) => {
        throw new SwfFailure(makeError('INVALID_INPUT', `frame for viewport "${view.viewportId}": ${message}`, {
            workspaceId: scene.workspaceId,
        }));
    };
    const issue = viewGeometryIssue(view);
    if (issue !== null) {
        fail(issue);
    }
    if (output.viewportId !== view.viewportId) {
        fail(`the view output belongs to viewport "${output.viewportId}"`);
    }
    if (output.sceneRevision !== scene.revision) {
        fail(`the view output is for revision ${String(output.sceneRevision)}, not ${String(scene.revision)}`);
    }
    if (view.projectionId !== input.projection.id) {
        fail(`the view uses projection "${view.projectionId}", not "${input.projection.id}"`);
    }
    // Every fragment of a surface is represented alike: the policy is asked once per surface.
    const representations = new Map();
    const representationOf = (surfaceId) => {
        const known = representations.get(surfaceId);
        if (known !== undefined) {
            return known;
        }
        const policy = input.representation;
        const nodeId = scene.surfaces.get(surfaceId)?.ownerNodeId;
        if (nodeId === undefined) {
            return fail(`surface "${surfaceId}" is not in the scene`);
        }
        const chosen = policy === undefined ? 'full' : representationFor(policy, { scene, view, surfaceId, nodeId });
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
    const negotiations = negotiateFragments({
        viewportId: view.viewportId,
        renderer: input.renderer,
        compositor: input.compositor,
        projection: input.projection,
    }, facts.map((f) => ({ ...f.negotiation, represented: f.representation !== 'full' })), input.policy ?? DEFAULT_FALLBACK_POLICY);
    const planned = facts.map(({ fragment, condition, representation }, i) => {
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
        fallbacks: Object.freeze(planned.flatMap((p) => (p.negotiation.fallback === null ? [] : [p.negotiation.fallback]))),
    });
}
/**
 * Fallback diagnostics grouped by their `groupKey`, so identical fallbacks (the same backends,
 * kind of endpoint, outcome and reasons) are reported once with a count, in first-seen order.
 */
export function groupFallbacks(fallbacks) {
    const groups = new Map();
    for (const fallback of fallbacks) {
        const group = groups.get(fallback.groupKey);
        if (group === undefined) {
            groups.set(fallback.groupKey, {
                example: fallback,
                count: 1,
                surfaceIds: [fallback.surfaceId],
            });
        }
        else {
            group.count += 1;
            if (!group.surfaceIds.includes(fallback.surfaceId)) {
                group.surfaceIds.push(fallback.surfaceId);
            }
        }
    }
    return [...groups.values()];
}
//# sourceMappingURL=stages.js.map