import { makeError, SwfFailure, VERSIONED_ID } from '@swf/core';
import { IDENTITY_MAT4, length } from '@swf/math';
import { projectionProfileIssue } from '@swf/presentation';
import { PROJECTION_API_VERSION } from './contract.js';
import { projectorOf } from './projector.js';
const PROJECTION_METHODS = [
    'describeDomain',
    'projectDirection',
    'unprojectPoint',
    'projectGeometry',
    'clipVisibility',
    'interactionRay',
];
/**
 * A registry of projection modules that registers each one with both `targets`, the scene's
 * projection kinds and the host's projectors, and withdraws it from both. It starts empty, and
 * holds the modules it is given as they are (not copied).
 *
 * @example
 * ```ts
 * const projections = createProjectionRegistry({ kinds: workspace, projectors: registry });
 * const withdraw = projections.register(equirectangular);
 * ```
 */
export function createProjectionRegistry(targets) {
    return new Registry(targets);
}
class Registry {
    #targets;
    #modules = new Map();
    constructor(targets) {
        this.#targets = targets;
    }
    get(id) {
        return this.#modules.get(id);
    }
    ids() {
        return [...this.#modules.keys()].sort();
    }
    register(module) {
        validateProjectionModule(module);
        if (this.#modules.has(module.id)) {
            fail('INVALID_INPUT', `projection "${module.id}" is already registered`);
        }
        const removeKind = this.#targets.kinds.registerProjectionKind(module);
        let removeProjector;
        try {
            removeProjector = this.#targets.projectors.registerProjector(projectorOf(module));
        }
        catch (error) {
            removeKind();
            throw error;
        }
        this.#modules.set(module.id, module);
        let removed = false;
        return () => {
            if (!removed) {
                removed = true;
                this.#modules.delete(module.id);
                removeProjector();
                removeKind();
            }
        };
    }
}
function fail(code, message) {
    throw new SwfFailure(makeError(code, message));
}
/**
 * Checks that a projection module is complete and behaves as it declares: its shape and contract
 * version, its profile, a projection created from its default configuration, that projection's
 * domain, and a round trip through the centre of a probe view. Throws {@link SwfFailure} naming
 * the first problem.
 */
export function validateProjectionModule(module) {
    const raw = module;
    if (typeof raw !== 'object' || raw === null) {
        fail('INVALID_INPUT', 'projection module must be an object');
    }
    if (typeof module.id !== 'string' || !VERSIONED_ID.test(module.id)) {
        fail('INVALID_INPUT', `projection module ID must look like "name/1" (got ${JSON.stringify(raw.id)})`);
    }
    const what = `projection "${module.id}"`;
    for (const method of ['configIssue', 'create']) {
        if (typeof module[method] !== 'function') {
            fail('INVALID_INPUT', `${what} must implement ${method}()`);
        }
    }
    if (module.apiVersion !== PROJECTION_API_VERSION) {
        fail('UNSUPPORTED_CAPABILITY', `${what} implements contract version ${String(module.apiVersion)}, not ${String(PROJECTION_API_VERSION)}`);
    }
    const profileIssue = projectionProfileIssue(module.profile);
    if (profileIssue !== null) {
        fail('UNSUPPORTED_CAPABILITY', `${what}: ${profileIssue}`);
    }
    if (module.profile.id !== module.id) {
        fail('UNSUPPORTED_CAPABILITY', `${what} has profile ID "${module.profile.id}"`);
    }
    const probe = (step, run) => {
        try {
            run();
        }
        catch (error) {
            if (error instanceof SwfFailure) {
                throw error;
            }
            fail('UNSUPPORTED_CAPABILITY', `${what} failed to ${step}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    let projection;
    probe('accept its default configuration', () => {
        const issue = module.configIssue(module.defaultConfig);
        if (issue !== null) {
            throw new Error(issue);
        }
        projection = module.create(module.defaultConfig);
    });
    if (projection === undefined || typeof projection !== 'object') {
        return fail('UNSUPPORTED_CAPABILITY', `${what} created no projection`);
    }
    const created = projection;
    for (const method of PROJECTION_METHODS) {
        if (typeof created[method] !== 'function') {
            fail('UNSUPPORTED_CAPABILITY', `${what} creates projections without ${method}()`);
        }
    }
    if (created.id !== module.id) {
        fail('UNSUPPORTED_CAPABILITY', `${what} creates projections with ID "${created.id}"`);
    }
    probe('describe its domain', () => {
        const issue = domainIssue(created.describeDomain(), module);
        if (issue !== null) {
            throw new Error(issue);
        }
    });
    probe('map the centre of a probe view and back', () => {
        const view = {
            viewportId: 'probe',
            width: 400,
            height: 200,
            devicePixelRatio: 1,
            camera: IDENTITY_MAT4,
            near: 0.05,
            far: null,
            projectionId: module.id,
            projectionConfig: module.defaultConfig,
        };
        const ray = created.unprojectPoint(200, 100, view);
        if (ray.kind !== 'ray') {
            throw new Error(`the centre is ${ray.kind}: ${ray.reason}`);
        }
        if (!(length(ray.ray.direction) > 0)) {
            throw new Error('the centre has no ray direction');
        }
        const images = created.projectDirection(ray.ray.direction, view).images;
        const tolerance = 1e-6 * view.width + created.describeDomain().maxInverseError * view.width;
        if (!images.some(([x, y]) => Math.hypot(x - 200, y - 100) <= tolerance)) {
            throw new Error(`the centre's ray projects to ${JSON.stringify(images)}, not back to (200, 100)`);
        }
    });
}
function domainIssue(domain, module) {
    const raw = domain;
    if (typeof raw !== 'object' || raw === null) {
        return 'domain must be an object';
    }
    const angle = (value, max) => typeof value === 'number' && value > 0 && value <= max + 1e-12;
    if (!angle(domain.horizontalCoverage, 2 * Math.PI)) {
        return 'horizontalCoverage must be in (0, 2π]';
    }
    if (!angle(domain.verticalCoverage, Math.PI)) {
        return 'verticalCoverage must be in (0, π]';
    }
    for (const key of [
        'seamWrapping',
        'fullCircle',
        'poles',
        'orientationDependent',
        'nonInjective',
    ]) {
        if (typeof domain[key] !== 'boolean') {
            return `${key} must be a boolean`;
        }
    }
    if (domain.fullCircle !== domain.horizontalCoverage >= 2 * Math.PI - 1e-12) {
        return 'fullCircle must hold exactly when horizontalCoverage is 2π';
    }
    if (domain.seamWrapping && !module.profile.seamWrapping) {
        return 'the domain wraps at a seam but the profile says it does not';
    }
    if ((domain.seamWrapping || domain.poles) && !domain.nonInjective) {
        return 'a seam or a pole row makes the mapping non-injective, but nonInjective is false';
    }
    // Modules may be plain JavaScript, so the declared kind is checked, not assumed.
    const inverse = domain.inverse;
    if (inverse !== 'exact' && inverse !== 'approximate') {
        return 'inverse must be "exact" or "approximate"';
    }
    if (!(domain.maxInverseError >= 0 && Number.isFinite(domain.maxInverseError))) {
        return 'maxInverseError must be a non-negative finite number';
    }
    if ((domain.inverse === 'exact') !== (domain.maxInverseError === 0)) {
        return 'maxInverseError must be 0 exactly when the inverse is exact';
    }
    if ((domain.inverse === 'exact') !== module.profile.exactInverse) {
        return `the inverse is ${domain.inverse} but the profile says exactInverse is ${String(module.profile.exactInverse)}`;
    }
    return null;
}
//# sourceMappingURL=registry.js.map