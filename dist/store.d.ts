/**
 * A snapshot as a store holds it: its JSON text and the workspace revision it was taken at. The
 * stores of this package hand it out frozen.
 */
export interface StoredSnapshot {
    /** The key it is stored under: a non-blank string. */
    readonly key: string;
    /** The workspace revision the snapshot was taken at: a whole number from 0. */
    readonly revision: number;
    /** The snapshot's JSON text, exactly as saved; the store does not parse or validate it. */
    readonly document: string;
    /** When the store saved it, in milliseconds by the store's `now` clock. */
    readonly savedAt: number;
    /** The document's UTF-8 size, in bytes. */
    readonly bytes: number;
}
/** A stored snapshot without its document: what {@link SnapshotStore.list} gives. Frozen. */
export type SnapshotEntry = Omit<StoredSnapshot, 'document'>;
/** One snapshot to store, and what the caller expects the store to hold before it. */
export interface SaveRequest {
    /** The key to store it under: a non-blank string. */
    readonly key: string;
    /** The snapshot's JSON text; the store keeps it as given. */
    readonly document: string;
    /**
     * The workspace revision the snapshot was taken at: a whole number from 0, and not below the
     * revision stored under `key`.
     */
    readonly revision: number;
    /**
     * The revision the caller last saw stored under `key`, or null when it saw none. A store with
     * compare-and-swap refuses the save when what it holds differs.
     */
    readonly expectedRevision: number | null;
}
/**
 * A store's acknowledgement that a save is stored as its guarantees promise: the key, revision,
 * time and size it stored. Frozen.
 */
export type SaveAck = SnapshotEntry;
/** What a store promises about its saves. */
export interface StoreGuarantees {
    /** A save replaces the previous snapshot entirely or not at all. */
    readonly atomic: boolean;
    /** A save is refused when the stored revision is not the one expected. */
    readonly compareAndSwap: boolean;
}
/**
 * Where snapshots are kept: the host's choice, replaceable. A store acknowledges a save only once
 * the snapshot is stored as its guarantees promise, never stores a snapshot over a newer revision,
 * and leaves what it held intact when a save fails. Its operations reject with
 * {@link @swf/core!SwfFailure}: `INVALID_INPUT` for a blank key or a malformed request (naming
 * the field), `CONFLICT` for a stale expectation or a newer stored revision
 * (`details.storedRevision` says what it holds), `QUOTA_EXCEEDED` when it is full,
 * `STORAGE_FAILED` for anything else. Each operation stands alone: a store holds no handle a
 * caller must release.
 */
export interface SnapshotStore {
    /** What the store promises about its saves; frozen. */
    readonly guarantees: StoreGuarantees;
    /**
     * The snapshot stored under `key`, or null when there is none. Rejects with `INVALID_INPUT`
     * (naming `key`) for a blank key, and `STORAGE_FAILED` when what is stored is damaged.
     */
    load(key: string): Promise<StoredSnapshot | null>;
    /**
     * Stores a snapshot under its key, replacing what was there, and resolves with the
     * acknowledgement once it is stored as {@link StoreGuarantees} promise. A store with
     * compare-and-swap first checks that it holds `expectedRevision` (none, for null) and that
     * `revision` is not older than what it holds, refusing with `CONFLICT` otherwise. A save that
     * is refused or fails leaves what the store held as it was.
     */
    save(request: SaveRequest): Promise<SaveAck>;
    /** Every stored snapshot without its document, sorted by key; a new array on every call. */
    list(): Promise<SnapshotEntry[]>;
    /**
     * Removes the snapshot stored under `key`: only the store's record, nothing it describes is
     * touched, nor any other key. Resolves true when there was one, false when there was none.
     */
    delete(key: string): Promise<boolean>;
}
/** How a memory store is limited and stamped. */
export interface MemoryStoreOptions {
    /**
     * The most all stored documents may take together, in UTF-8 bytes: a positive whole number, or
     * `Infinity`. A save that would go over it is refused with `QUOTA_EXCEEDED`
     * (`details.bytes`, `details.limit`). Default: no limit.
     */
    readonly maxBytes?: number;
    /** The clock saves are stamped with, in milliseconds; a function. Default `Date.now`. */
    readonly now?: () => number;
}
/**
 * A store in memory, atomic and with compare-and-swap: for tests, for hosts that keep layouts
 * only for a session, and as the model other stores follow. Its snapshots live as long as the
 * store; there is nothing to close.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `maxBytes` or `now` when either
 *   is invalid.
 */
export declare function createMemoryStore(options?: MemoryStoreOptions): SnapshotStore;
//# sourceMappingURL=store.d.ts.map