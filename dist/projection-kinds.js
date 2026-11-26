import { thrownText } from './errors.js';
import { describe, describeAnswer } from './json.js';
import { VERSIONED_ID } from './validate.js';
/**
 * What `kind.configIssue` finds wrong with `config`, or null when it is valid. A configIssue that
 * throws or answers anything but text or null is reported as the issue, naming the projection.
 */
export function projectionConfigIssue(kind, config) {
    let issue;
    try {
        issue = kind.configIssue(config);
    }
    catch (error) {
        return `projection "${kind.id}": its configIssue threw: ${thrownText(error)}`;
    }
    if (issue === null || typeof issue === 'string') {
        return issue;
    }
    return `projection "${kind.id}": its configIssue returned ${describeAnswer(issue)}, not text or null`;
}
/** The projection kinds a workspace accepts viewports for. */
export class ProjectionKindRegistry {
    #kinds = new Map();
    get(id) {
        return this.#kinds.get(id);
    }
    /**
     * Adds a kind; throws a TypeError naming the problem when it is malformed or its ID is taken.
     * The returned function removes it (safe to call twice); viewports already using it keep their
     * settings, and new ones cannot choose it.
     */
    register(kind) {
        const k = kind;
        if (typeof k !== 'object' || k === null) {
            throw new TypeError(`projection kind must be an object (got ${describe(k)})`);
        }
        const id = k.id;
        if (typeof id !== 'string' || !VERSIONED_ID.test(id)) {
            throw new TypeError(`projection kind id ${JSON.stringify(id)} must be a versioned ID "<name>/<version>"`);
        }
        if (typeof k.configIssue !== 'function') {
            throw new TypeError(`projection kind "${id}" must implement configIssue()`);
        }
        if (this.#kinds.has(id)) {
            throw new TypeError(`projection kind "${id}" is already registered`);
        }
        this.#kinds.set(id, kind);
        return () => {
            if (this.#kinds.get(id) === kind) {
                this.#kinds.delete(id);
            }
        };
    }
}
//# sourceMappingURL=projection-kinds.js.map