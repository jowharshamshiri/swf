import type { SwfError } from '@swf/core';
import { jsonValue, SwfFailure } from '@swf/core';
import type { SnapshotLimits, WorkspaceDocument } from './document.js';
import {
  DEFAULT_SNAPSHOT_LIMITS,
  failure,
  SNAPSHOT_SCHEMA_ID,
  validateDocument,
} from './document.js';

/**
 * One step of the snapshot format: it reads documents of format `from` and writes them as format
 * `to`. It gets a copy of its own to change and never sees the workspace.
 */
export interface SchemaMigration {
  readonly from: string;
  readonly to: string;
  migrate(document: Record<string, unknown>): {
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
export const SNAPSHOT_MIGRATIONS: readonly SchemaMigration[] = Object.freeze([]);

export interface MigrationStep {
  readonly from: string;
  readonly to: string;
  readonly warnings: readonly string[];
}

/** A document brought to the current format, with how it got there. */
export interface Migrated {
  readonly document: WorkspaceDocument;
  /** The format the document was in. */
  readonly sourceVersion: string;
  /** The format it is in now: always {@link SNAPSHOT_SCHEMA_ID}. */
  readonly targetVersion: string;
  readonly steps: readonly MigrationStep[];
}

/**
 * Brings a snapshot of any format still read to the current one and validates it. Each step works
 * on a copy of its own, so the input is never changed and a failure leaves nothing half done.
 * `migrations` are tried before the built-in steps (a host's converter of an older layout, say).
 * Throws {@link SwfFailure} with `details.sourceVersion`: `SNAPSHOT_INVALID` for a format no step
 * leads from, or a result that is not valid, `MIGRATION_FAILED` for a step that throws or does not
 * write its format.
 */
export function migrateDocument(
  value: unknown,
  options: {
    readonly migrations?: readonly SchemaMigration[];
    readonly limits?: SnapshotLimits;
  } = {},
): Migrated {
  const migrations = [...(options.migrations ?? []), ...SNAPSHOT_MIGRATIONS];
  const limits = options.limits ?? DEFAULT_SNAPSHOT_LIMITS;
  const schema =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)['schema']
      : undefined;
  if (typeof schema !== 'string') {
    throw failure('SNAPSHOT_INVALID', 'a snapshot names its format in "schema"', 'schema', {
      sourceVersion: null,
    });
  }
  const sourceVersion = schema;
  const withSource = (error: SwfError, extra: Readonly<Record<string, unknown>> = {}) =>
    new SwfFailure({
      ...error,
      details: { ...(error.details ?? {}), ...extra, sourceVersion },
    });
  let current: unknown = value;
  let version = sourceVersion;
  const steps: MigrationStep[] = [];
  const seen = new Set<string>();
  while (version !== SNAPSHOT_SCHEMA_ID) {
    const step = migrations.find((m) => m.from === version);
    if (step === undefined || seen.has(version)) {
      throw failure(
        'SNAPSHOT_INVALID',
        `schema "${version}" is not supported: this engine reads "${SNAPSHOT_SCHEMA_ID}" and migrates ${migrations.length === 0 ? 'no older format' : `from ${migrations.map((m) => `"${m.from}"`).join(', ')}`}`,
        'schema',
        { sourceVersion },
      );
    }
    seen.add(version);
    let copy: Record<string, unknown>;
    try {
      // The step's own copy: JSON data only, nothing shared with the input.
      copy = JSON.parse(JSON.stringify(jsonValue(current, 'snapshot'))) as Record<string, unknown>;
    } catch (error) {
      throw error instanceof SwfFailure
        ? withSource({ ...error.error, code: 'SNAPSHOT_INVALID' })
        : error;
    }
    let result: ReturnType<SchemaMigration['migrate']>;
    try {
      result = step.migrate(copy);
    } catch (error) {
      throw failure(
        'MIGRATION_FAILED',
        `migrating from "${step.from}" to "${step.to}" failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { sourceVersion, from: step.from, to: step.to },
      );
    }
    const written = (result.document as { schema?: unknown } | null)?.schema;
    if (written !== step.to) {
      throw failure(
        'MIGRATION_FAILED',
        `the migration from "${step.from}" wrote format ${JSON.stringify(written)}, not "${step.to}"`,
        'schema',
        { sourceVersion, from: step.from, to: step.to },
      );
    }
    steps.push(
      Object.freeze({
        from: step.from,
        to: step.to,
        warnings: Object.freeze([...(result.warnings ?? [])].map(String)),
      }),
    );
    current = result.document;
    version = step.to;
  }
  try {
    return Object.freeze({
      document: validateDocument(current, limits),
      sourceVersion,
      targetVersion: SNAPSHOT_SCHEMA_ID,
      steps: Object.freeze(steps),
    });
  } catch (error) {
    throw error instanceof SwfFailure ? withSource(error.error) : error;
  }
}
