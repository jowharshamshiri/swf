import type { JsonValue, SceneSnapshot, SwfError, SwfErrorCode } from '@swf/core';
import { SwfFailure } from '@swf/core';
/** The snapshot format this package reads and writes. */
export declare const SNAPSHOT_SCHEMA_ID = "swf.workspace/1";
/** The engine that writes snapshots, as recorded in each one. */
export declare const SNAPSHOT_ENGINE = "swf.persistence/1";
/**
 * The published JSON Schema of {@link SNAPSHOT_SCHEMA_ID} (draft 2020-12), deeply frozen; the same
 * as `@swf/persistence/schema/swf.workspace-1.schema.json`. {@link validateDocument} enforces
 * everything it says, and what a schema cannot: references that hold, unique IDs, a hierarchy
 * without cycles and the size limits.
 */
export declare const SNAPSHOT_SCHEMA: Readonly<Record<string, unknown>>;
/**
 * A workspace snapshot: the format's ID, the engine that wrote it and when, the scene, the
 * active policies' parameters and the extensions' opaque state. Fields come in a fixed order,
 * entities by ID and object keys sorted, so equal snapshots have identical JSON text.
 */
export interface WorkspaceDocument extends SceneSnapshot {
    /** The format: always {@link SNAPSHOT_SCHEMA_ID}. */
    readonly schema: typeof SNAPSHOT_SCHEMA_ID;
    /**
     * The engine that wrote the snapshot, as a versioned ID `<name>/<version>`;
     * {@link SNAPSHOT_ENGINE} for snapshots this package captures.
     */
    readonly engine: string;
    /** When the snapshot was taken, in milliseconds since the epoch: finite, at least 0. */
    readonly createdAt: number;
    /** Policy parameters, by the policy's versioned ID, as JSON data in canonical form. */
    readonly policies: Readonly<Record<string, JsonValue>>;
    /**
     * Extension state by namespace (`host.<name>` or `ext.<extension-id>`, see {@link NAMESPACE}),
     * with the version of the extension's own format.
     */
    readonly extensions: Readonly<Record<string, ExtensionEntry>>;
}
/** One extension's state in a snapshot: opaque to the framework, which only checks its size. */
export interface ExtensionEntry {
    /** The version of the extension's own payload format: a whole number of at least 1. */
    readonly version: number;
    /**
     * The state, as JSON data in canonical form; at most {@link SnapshotLimits.extensionBytes} of
     * canonical JSON text.
     */
    readonly data: JsonValue;
}
/** Size limits, in UTF-8 bytes, each a whole number of at least 1. */
export interface SnapshotLimits {
    /** A whole snapshot's JSON text. Default 32 MiB. */
    readonly maxBytes: number;
    /** One extension namespace's data. Default 1 MiB. */
    readonly extensionBytes: number;
    /** All extension data together. Default 10 MiB. */
    readonly extensionTotalBytes: number;
}
/** The limits used where none are given: 32 MiB, 1 MiB per namespace, 10 MiB in all. Frozen. */
export declare const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits;
/**
 * What an extension namespace must match: `host.<name>` or `ext.<extension-id>`, with further
 * dot-separated parts, each of ASCII letters, digits, `_` and `-`.
 */
export declare const NAMESPACE: RegExp;
/**
 * Checks limits a host supplies, filling the rest from {@link DEFAULT_SNAPSHOT_LIMITS}. A new
 * frozen object.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `limits.<field>` for a field that
 *   is not a limit, or a value that is not a whole number of at least 1.
 */
export declare function snapshotLimits(limits?: Partial<SnapshotLimits>): SnapshotLimits;
/**
 * Validates a snapshot and returns its canonical, deeply frozen copy; the input is never changed.
 * Nothing in a snapshot is ever run.
 *
 * @param value - The snapshot, as parsed JSON or a document; anything else is refused.
 * @param limits - The size limits its extension state is held to. Default
 *   {@link DEFAULT_SNAPSHOT_LIMITS}.
 * @throws {@link @swf/core!SwfFailure} `SNAPSHOT_INVALID` naming the first failing path: a format
 *   other than {@link SNAPSHOT_SCHEMA_ID} (with `details.sourceVersion`), a malformed, unknown,
 *   missing or non-finite field, a key that could reach an object's prototype, a cycle (in data
 *   or in the hierarchy), a broken reference, or an extension over its size limit
 *   (`details.bytes`, `details.limit`).
 */
export declare function validateDocument(value: unknown, limits?: SnapshotLimits): WorkspaceDocument;
/**
 * Reads a snapshot from its JSON text: checks its size before parsing, then validates it as
 * {@link validateDocument} does. It reads only the current format; {@link migrateDocument} brings
 * older ones forward.
 *
 * @throws {@link @swf/core!SwfFailure} `SNAPSHOT_INVALID`, as {@link parseJson} and
 *   {@link validateDocument} do.
 */
export declare function parseDocument(text: unknown, limits?: SnapshotLimits): WorkspaceDocument;
/**
 * JSON text read safely: its UTF-8 size is checked against `limits.maxBytes` before it is parsed.
 * The value is parsed only, not validated.
 *
 * @throws {@link @swf/core!SwfFailure} `SNAPSHOT_INVALID` for a value that is not a string, text
 *   over the limit (`details.bytes`, `details.limit`), or text that is not JSON, saying where it
 *   breaks and what was expected there (`details.line`, `details.column`, `details.offset`;
 *   see {@link jsonSyntaxError}).
 */
export declare function parseJson(text: unknown, limits?: SnapshotLimits): unknown;
/**
 * The snapshot's canonical JSON text, UTF-8 ready, without indentation: equal snapshots give
 * identical text. It is validated first, so only a valid snapshot is ever written.
 *
 * @throws {@link @swf/core!SwfFailure} `SNAPSHOT_INVALID` for an invalid snapshot, as
 *   {@link validateDocument} says; `QUOTA_EXCEEDED` when its text is over `limits.maxBytes`
 *   (`details.bytes`, `details.limit`).
 */
export declare function exportDocument(document: WorkspaceDocument, limits?: SnapshotLimits): string;
/**
 * The size of a string encoded as UTF-8, in bytes, without encoding it. A lone surrogate counts as
 * the three bytes of the replacement character it is encoded as.
 */
export declare function utf8Length(text: string): number;
/** The UTF-8 size of a JSON value's canonical text. */
export declare function jsonBytes(value: JsonValue): number;
export declare function failure(code: SwfErrorCode, message: string, path?: string, details?: Readonly<Record<string, unknown>>): SwfFailure;
export declare function errorOf(code: SwfErrorCode, message: string, path?: string, details?: Readonly<Record<string, unknown>>): SwfError;
export declare function deepFreeze<T>(value: T): T;
//# sourceMappingURL=document.d.ts.map