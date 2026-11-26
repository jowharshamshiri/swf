import { makeError, SwfFailure } from '@swf/core';
import { models } from '@swf/models';
/** Every {@link PresentationMode}, best first; frozen. */
export const PRESENTATION_MODES = Object.freeze([
    'exact',
    'native',
    'approximated',
    'proxy',
    'placeholder',
]);
/** The policy used when none is given: every mode, best first ({@link PRESENTATION_MODES}). */
export const DEFAULT_FALLBACK_POLICY = Object.freeze({
    order: PRESENTATION_MODES,
});
/**
 * Validates a fallback order and makes it a policy. Throws {@link SwfFailure} (`INVALID_INPUT`,
 * with path `order`) naming the problem: an order that is not an array or is empty, an entry
 * that is not a presentation mode, a mode listed twice, or a last mode other than `placeholder`.
 * The policy returned is frozen and holds its own frozen copy of the order.
 */
export function fallbackPolicy(order) {
    const fail = (message) => {
        throw new SwfFailure(makeError('INVALID_INPUT', `fallback policy ${message}`, { path: 'order' }));
    };
    const given = order;
    if (!Array.isArray(given)) {
        return fail('must list at least one mode');
    }
    const names = given;
    const modes = names.filter((mode) => typeof mode === 'string');
    const stranger = names.find((mode) => typeof mode !== 'string');
    if (modes.length !== names.length) {
        fail(`names ${JSON.stringify(stranger)}, not a presentation mode (${PRESENTATION_MODES.join(', ')})`);
    }
    const issue = models.policyIssue(modes);
    if (issue !== null) {
        switch (issue.kind) {
            case 'empty':
                return fail('must list at least one mode');
            case 'unknown':
                return fail(`names ${JSON.stringify(issue.name)}, not a presentation mode (${PRESENTATION_MODES.join(', ')})`);
            case 'repeats':
                return fail(`repeats ${issue.m.kind}`);
            case 'notEndingWithPlaceholder':
                return fail('must end with placeholder, the mode that is always possible');
        }
    }
    // The model found every entry a mode.
    return Object.freeze({ order: Object.freeze(modes) });
}
/**
 * Chooses how to present a surface in a viewport: the first mode of the policy that the surface,
 * renderer, compositor, projection, geometry and ownership all allow. Every better mode that was
 * ruled out is reported with the requirement that ruled it out. The fallback model
 * (`Swf.Fallback`) decides. The surface is taken as its own native-owner fragment, shown in full;
 * {@link planFrame} negotiates a whole frame's fragments. The result is frozen.
 *
 * @param policy - Default {@link DEFAULT_FALLBACK_POLICY}; one made by {@link fallbackPolicy}
 *   always ends with `placeholder`.
 * @throws Error when no mode of the policy is possible, which only a policy not ending with
 *   `placeholder` allows.
 */
export function negotiate(input, policy = DEFAULT_FALLBACK_POLICY) {
    const [only] = negotiateFragments(input, [{ ...input, nativeOwner: true, represented: false }], policy);
    if (only === undefined) {
        throw new Error('the fallback model answered no fragment');
    }
    return only;
}
/** Negotiates every fragment of a frame at once, in order: one decision of the fallback model. */
export function negotiateFragments(backends, fragments, policy = DEFAULT_FALLBACK_POLICY) {
    if (fragments.length === 0) {
        return [];
    }
    const order = policy.order.map((mode) => ({ kind: mode }));
    const answers = models.negotiateFrame({
        renderer: {
            handleKinds: Object.entries(backends.renderer.capabilities.handleKinds).map(([strategy, fidelity]) => [
                leanStrategy(strategy),
                { kind: fidelity },
            ]),
            transformMode: { kind: TRANSFORM_MODES[backends.renderer.capabilities.transformMode] },
            clipping: { kind: backends.renderer.capabilities.clipping },
        },
        compositor: {
            layerCategories: backends.compositor.capabilities.layerCategories.map((category) => ({ kind: LEAN_LAYERS[category] })),
            directNative: backends.compositor.capabilities.directNative,
            clipping: { kind: backends.compositor.capabilities.clipping },
            transparency: backends.compositor.capabilities.transparency,
        },
        nonlinear: backends.projection.mapping === 'nonlinear',
    }, fragments.map((fragment) => ({
        handle: fragment.surface === null
            ? null
            : {
                strategy: leanStrategy(fragment.surface.attachStrategy),
                nativeInteraction: { kind: LEAN_INTERACTIONS[fragment.surface.nativeInteraction] },
                transformFidelity: { kind: fragment.surface.transformFidelity },
                transparency: fragment.surface.transparency,
                shared: fragment.surface.viewportSharing === 'shared',
            },
        geometryKind: fragment.geometry.kind,
        geometrySupported: fragment.geometry.supported,
        geometryExact: fragment.geometry.fidelity === 'exact',
        anchorExact: fragment.anchor === 'exact',
        viewportOwns: fragment.owner,
        nativeOwner: fragment.nativeOwner,
        order,
        represented: fragment.represented,
    })));
    return fragments.map((fragment, i) => {
        const answer = answers[i];
        if (answer === undefined || answer === null) {
            throw new Error(`the fallback policy left surface "${fragment.surfaceId}" with no mode: it must end with placeholder`);
        }
        return result({ ...fragment, ...backends }, answer, fragment.represented, policy);
    });
}
function result(input, answer, represented, policy) {
    const mode = answer.mode.kind;
    const gaps = answer.gaps.map((gap) => Object.freeze({ mode: gap.mode.kind, requirement: gap.requirement.kind, detail: gap.detail }));
    const tried = standInModes(represented, policy);
    const preferred = tried[0] ?? mode;
    const fallback = mode === preferred
        ? null
        : Object.freeze({
            code: 'PRESENTATION_FALLBACK',
            surfaceId: input.surfaceId,
            viewportId: input.viewportId,
            rendererId: input.renderer.id,
            compositorId: input.compositor.id,
            projectionId: input.projection.id,
            preferred,
            chosen: mode,
            gaps: Object.freeze(gaps),
            groupKey: [
                input.renderer.id,
                input.compositor.id,
                input.projection.id,
                input.surface?.attachStrategy ?? 'unbound',
                mode,
                ...gaps.map((g) => `${g.mode}:${g.requirement}:${g.detail}`),
            ].join('|'),
            message: `surface "${input.surfaceId}" is presented as ${mode} in viewport "${input.viewportId}" instead of ${preferred}: ${gaps
                .map((g) => `${g.mode} needs ${g.requirement} (${g.detail})`)
                .join('; ')}`,
        });
    return Object.freeze({
        surfaceId: input.surfaceId,
        viewportId: input.viewportId,
        mode,
        anchorFidelity: input.anchor,
        shapeFidelity: answer.shape.kind,
        contentFidelity: answer.content.kind,
        interaction: INTERACTIONS[answer.interaction.kind],
        layer: LAYERS[answer.layer.kind],
        fallback,
    });
}
/**
 * The modes negotiation tries, in the policy's order: for a surface the viewport represents (a
 * compact preview or its label), only the stand-ins, proxy and placeholder.
 */
export function standInModes(represented, policy) {
    return Object.freeze(models
        .representedModes(represented, policy.order.map((mode) => ({ kind: mode })))
        .map((mode) => mode.kind));
}
const STRATEGIES = Object.freeze({
    'native-dom': 'nativeDom',
    drawable: 'drawable',
    'proxy-only': 'proxyOnly',
});
function leanStrategy(strategy) {
    return { kind: STRATEGIES[strategy] };
}
const TRANSFORM_MODES = Object.freeze({
    translate: 'translate',
    'affine-2d': 'affine2d',
    'perspective-3d': 'perspective3d',
    mesh: 'mesh',
});
const LEAN_INTERACTIONS = Object.freeze({ full: 'full', partial: 'partly', none: 'none' });
const INTERACTIONS = Object.freeze({
    full: 'full',
    partly: 'partial',
    none: 'none',
});
const LEAN_LAYERS = Object.freeze({
    'content-native': 'contentNative',
    'content-raster': 'contentRaster',
    proxy: 'proxy',
    placeholder: 'placeholder',
    chrome: 'chrome',
    overlay: 'overlay',
});
const LAYERS = Object.freeze({
    contentNative: 'content-native',
    contentRaster: 'content-raster',
    proxy: 'proxy',
    placeholder: 'placeholder',
    chrome: 'chrome',
    overlay: 'overlay',
});
//# sourceMappingURL=negotiation.js.map