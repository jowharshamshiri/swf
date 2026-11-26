import { jsonValue, SwfFailure } from '@swf/core';
import { models } from '@swf/models';
import { answeredWithPromise, describeAnswer } from './answers.js';
import { DEFAULT_SNAPSHOT_LIMITS, failure, SNAPSHOT_SCHEMA_ID, validateDocument, } from './document.js';
/**
 * The steps of the snapshot format, oldest first. `swf.workspace/1` is the first published
 * format, so there is no step yet: each later format adds the step from the one before, with
 * fixtures of every format still read.
 */
export const SNAPSHOT_MIGRATIONS = Object.freeze([]);
/**
 * Brings a snapshot of any format still read to the current one and validates it. Each step works
 * on a copy of its own, so the input is never changed and a failure leaves nothing half done.
 * `migrations` are tried before the built-in steps (a host's converter of an older layout, say).
 *
 * @param value - The snapshot, as parsed JSON; it names its format in `schema`.
 * @param options - Steps of the host's own (default none), and the limits the result is
 *   validated within (default {@link DEFAULT_SNAPSHOT_LIMITS}).
 * @throws {@link @swf/core!SwfFailure} with `details.sourceVersion` (null when the snapshot names
 *   no format): `SNAPSHOT_INVALID` for a snapshot without a `schema`, a format no step leads
 *   from, data a step cannot be given, or a result that is not valid; `MIGRATION_FAILED` for a
 *   step that throws or does not write its format (with `details.from` and `details.to`).
 */
export function migrateDocument(value, options = {}) {
    const migrations = [...(options.migrations ?? []), ...SNAPSHOT_MIGRATIONS];
    const limits = options.limits ?? DEFAULT_SNAPSHOT_LIMITS;
    const schema = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value['schema']
        : undefined;
    if (typeof schema !== 'string') {
        throw failure('SNAPSHOT_INVALID', 'a snapshot names its format in "schema"', 'schema', {
            sourceVersion: null,
        });
    }
    const sourceVersion = schema;
    const withSource = (error, extra = {}) => new SwfFailure({
        ...error,
        details: { ...(error.details ?? {}), ...extra, sourceVersion },
    });
    // The migration model (`Swf.Migration`) plans the steps; they run here, each on a copy of its own.
    const plan = models.migrationPlan(migrations.map((m) => [m.from, m.to]), sourceVersion, SNAPSHOT_SCHEMA_ID);
    let current = value;
    const steps = [];
    for (const index of plan.steps) {
        const step = migrations[Number(index)];
        if (step === undefined) {
            throw new Error(`the migration model planned step ${String(index)}, which is not given`);
        }
        let copy;
        try {
            // The step's own copy: JSON data only, nothing shared with the input.
            copy = JSON.parse(JSON.stringify(jsonValue(current, 'snapshot')));
        }
        catch (error) {
            throw error instanceof SwfFailure
                ? withSource({ ...error.error, code: 'SNAPSHOT_INVALID' })
                : error;
        }
        const stepFailed = (message, path) => failure('MIGRATION_FAILED', message, path, {
            sourceVersion,
            from: step.from,
            to: step.to,
        });
        let result;
        let document;
        let warnings;
        let written;
        try {
            result = step.migrate(copy);
            if (typeof result === 'object' && result !== null && !answeredWithPromise(result)) {
                ({ document, warnings } = result);
                written =
                    typeof document === 'object' && document !== null
                        ? document.schema
                        : undefined;
            }
        }
        catch (error) {
            throw stepFailed(`migrating from "${step.from}" to "${step.to}" failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (answeredWithPromise(result)) {
            throw stepFailed(`the migration from "${step.from}" returned a promise; a step runs synchronously`);
        }
        if (typeof result !== 'object' || result === null) {
            throw stepFailed(`the migration from "${step.from}" returned ${describeAnswer(result)}, not { document, warnings }`);
        }
        if (warnings !== undefined &&
            !(Array.isArray(warnings) && warnings.every((w) => typeof w === 'string'))) {
            throw stepFailed(`the migration from "${step.from}": warnings must be a list of strings`, 'warnings');
        }
        if (written !== step.to) {
            throw stepFailed(`the migration from "${step.from}" wrote format ${typeof written === 'string' ? JSON.stringify(written) : describeAnswer(written)}, not "${step.to}"`, 'schema');
        }
        steps.push(Object.freeze({
            from: step.from,
            to: step.to,
            warnings: Object.freeze([...(warnings ?? [])]),
        }));
        current = document;
    }
    if (plan.blocked !== null) {
        throw failure('SNAPSHOT_INVALID', `schema "${plan.blocked}" is not supported: this engine reads "${SNAPSHOT_SCHEMA_ID}" and migrates ${migrations.length === 0 ? 'no older format' : `from ${migrations.map((m) => `"${m.from}"`).join(', ')}`}`, 'schema', { sourceVersion });
    }
    try {
        return Object.freeze({
            document: validateDocument(current, limits),
            sourceVersion,
            targetVersion: SNAPSHOT_SCHEMA_ID,
            steps: Object.freeze(steps),
        });
    }
    catch (error) {
        throw error instanceof SwfFailure ? withSource(error.error) : error;
    }
}
//# sourceMappingURL=migrations.js.map