import { VERSIONED_ID } from '@swf/core';
import { capabilitiesIssue } from './capabilities.js';
/**
 * The version of the adapter contract this package implements. An adapter states it as its
 * {@link SurfaceAdapter.apiVersion}; any other value is refused at registration with
 * `UNSUPPORTED_CAPABILITY`.
 */
export const ADAPTER_API_VERSION = 1;
/**
 * Why an adapter cannot be registered, or null when it can: `INVALID_INPUT` for a malformed
 * adapter, `UNSUPPORTED_CAPABILITY` for an incompatible contract version or contradictory
 * capability declarations.
 */
export function adapterIssue(adapter) {
    const malformed = (message) => ({ code: 'INVALID_INPUT', message });
    const incompatible = (message) => ({ code: 'UNSUPPORTED_CAPABILITY', message });
    if (typeof adapter !== 'object' || adapter === null) {
        return malformed('adapter must be an object');
    }
    const a = adapter;
    const id = a['id'];
    if (typeof id !== 'string' || !VERSIONED_ID.test(id)) {
        return malformed(`adapter id ${JSON.stringify(id)} must be a versioned type ID "<name>/<version>", such as "host.video/1"`);
    }
    for (const method of ['resolve', 'capabilities', 'attach', 'update', 'detach']) {
        if (typeof a[method] !== 'function') {
            return malformed(`adapter "${id}" must implement ${method}()`);
        }
    }
    if (a['untimedBinding'] !== undefined && typeof a['untimedBinding'] !== 'boolean') {
        return malformed(`adapter "${id}" untimedBinding must be a boolean`);
    }
    if (a['apiVersion'] !== ADAPTER_API_VERSION) {
        return incompatible(`adapter "${id}" implements contract version ${JSON.stringify(a['apiVersion'])}, not ${ADAPTER_API_VERSION}`);
    }
    const issue = capabilitiesIssue(a['declaredCapabilities']);
    if (issue !== null) {
        return incompatible(`adapter "${id}" declares invalid capabilities: ${issue}`);
    }
    return null;
}
//# sourceMappingURL=adapter.js.map