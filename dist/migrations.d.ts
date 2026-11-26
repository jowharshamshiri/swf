import type { SnapshotLimits, WorkspaceDocument } from './document.js';
/**
 * One step of the snapshot format: it reads documents of format `from` and writes them as format
 * `to`. It gets a copy of its own to change and never sees the workspace.
 */
export interface SchemaMigration {
    /** The format it reads, as a document's `schema` names it. */
    readonly from: string;
    /** The format it writes; the document it returns must name it in `schema`. */
    readonly to: string;
    /**
     * Turns a document of format `from` into one of format `to`, synchronously. The document is a
     * JSON copy of the step's own, which it may change and return. A throw, a promise, an answer
     * that is not an object or `warnings` that are not a list of strings fail the migration with
     * `MIGRATION_FAILED`.
     */
    migrate(document: Record<string, unknown>): {
        /** The document in format `to`: it is checked as JSON data before the next step reads it. */
        readonly document: unknown;
        /** What the step could not carry over exactly, for the person restoring. */
        readonly warnings?: readonly string[];
    };
}
/**
 * The steps of the snapshot format, oldest first. `swf.workspace/1` is the first published
 * format, so there is no step yet: each later format adds the step from the one before, with
 * fixtures of every format still read.
 */
export declare const SNAPSHOT_MIGRATIONS: readonly SchemaMigration[];
/** One migration step that ran, as a restore reports it. Frozen. */
export interface MigrationStep {
    /** The format it read. */
    readonly from: string;
    /** The format it wrote. */
    readonly to: string;
    /** What it could not carry over exactly, as it said, each as a string. */
    readonly warnings: readonly string[];
}
/** A document brought to the current format, with how it got there. Frozen. */
export interface Migrated {
    /** The document in the current format: validated, canonical and deeply frozen. */
    readonly document: WorkspaceDocument;
    /** The format the document was in. */
    readonly sourceVersion: string;
    /** The format it is in now: always {@link SNAPSHOT_SCHEMA_ID}. */
    readonly targetVersion: string;
    /** The steps that ran, in order: none when the document was in the current format. */
    readonly steps: readonly MigrationStep[];
}
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
export declare function migrateDocument(value: unknown, options?: {
    readonly migrations?: readonly SchemaMigration[];
    readonly limits?: SnapshotLimits;
}): Migrated;
//# sourceMappingURL=migrations.d.ts.map