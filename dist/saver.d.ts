import type { SwfError } from '@swf/core';
import type { CaptureFailure, Persistence } from './persistence.js';
import type { SaveAck, SnapshotStore } from './store.js';
/**
 * Where a workspace's saving is: `clean` when the store holds what the workspace shows, `dirty`
 * after a change, `saving` while a save is under way, `failed` after a save the store did not
 * acknowledge (the workspace is still unsaved, and the store holds what it held before).
 */
export type SaveState = 'clean' | 'dirty' | 'saving' | 'failed';
/** What a saver saves, where, and what the store already holds. */
export interface SaverOptions {
    /**
     * The workspace's persistence, which captures and exports each snapshot. The saver follows its
     * changes and never disposes it.
     */
    readonly persistence: Persistence;
    /** The store the snapshots go to. The saver only saves to it, under `key`; it never deletes. */
    readonly store: SnapshotStore;
    /** The key the workspace's snapshot is stored under: a non-blank string. */
    readonly key: string;
    /**
     * What the store holds under `key` already and the workspace shows (after a restore, say): the
     * change count it reflects and its revision. With it the saver opens `clean` when that change
     * count is the persistence's current one; without it the workspace counts as unsaved and the
     * first save expects the store to hold nothing under `key`.
     */
    readonly saved?: {
        /** The revision the store holds: a whole number from 0. */
        readonly revision: number;
        /** The {@link Persistence.changes} count that snapshot reflects: a whole number. */
        readonly changes: number;
    };
}
/** How one {@link Saver.save} ended. Frozen. */
export type SaveOutcome = {
    /** The store acknowledged the snapshot. */
    readonly status: 'saved';
    /** The store's acknowledgement, of exactly the key and revision saved. */
    readonly ack: SaveAck;
    /** States that could not be captured; the snapshot carries their last known state. */
    readonly failures: readonly CaptureFailure[];
} | {
    /** The store already holds what the workspace shows: nothing was captured or saved. */
    readonly status: 'unchanged';
} | {
    /** The save failed; the saver is `failed` and the store holds what it held before. */
    readonly status: 'failed';
    /**
     * Why: the store's error (`CONFLICT`, `QUOTA_EXCEEDED`, `STORAGE_FAILED`, …), a capture
     * that failed, or `STORAGE_FAILED` for an acknowledgement of another key or revision, or of
     * a revision older than the one the store already acknowledged.
     */
    readonly error: SwfError;
};
/**
 * Saves one workspace to one store key, following the snapshot save state machine. The caller
 * owns it and calls {@link Saver.dispose} when done; it never disposes the persistence or the
 * store.
 */
export interface Saver {
    /** Where saving is now; see {@link SaveState}. */
    readonly state: SaveState;
    /** The revision the store acknowledged last, or null before any. */
    readonly savedRevision: number | null;
    /** Why the last save failed, or null when it succeeded or none has ended yet. */
    readonly lastError: SwfError | null;
    /**
     * Saves what the workspace shows now: captures a snapshot and stores it, expecting the store to
     * hold the last acknowledged revision. Only an acknowledgement of exactly that key and revision
     * counts; it makes the state `clean` when nothing changed meanwhile, `dirty` otherwise. A save
     * asked for while one runs follows it. A retry always captures afresh, so it never stores an
     * older revision, and a store that holds a newer one refuses it.
     *
     * It never rejects: a failure resolves as `failed`, with the saver `failed` until the next
     * save. A change during a save keeps the state `saving` and makes it `dirty` once acknowledged.
     */
    save(): Promise<SaveOutcome>;
    /**
     * Calls `listener` with each new state. A listener that throws does not stop saving or the
     * others; its failure is kept in {@link getDiagnostics}. Returns an idempotent unsubscribe.
     */
    subscribe(listener: (state: SaveState) => void): () => void;
    /** The last 100 listener failures, oldest first, as messages; a new frozen array on each call. */
    getDiagnostics(): readonly string[];
    /**
     * Stops following the persistence's changes and drops every listener; the persistence and the
     * store are left as they are. A save under way still ends. Safe to call twice.
     */
    dispose(): void;
}
/**
 * Creates a saver of one workspace's snapshots to one store key, `clean` or `dirty` as
 * {@link SaverOptions.saved} says. The caller owns it and disposes it.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `key` for a blank or missing key,
 *   or `saved` when it does not give a whole revision of at least 0 and a whole change count.
 *   `persistence` and `store` are used as given.
 */
export declare function createSaver(options: SaverOptions): Saver;
//# sourceMappingURL=saver.d.ts.map