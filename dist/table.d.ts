import type { Id } from './model.js';
/** Read access to records by ID, in a stable insertion order. */
export interface RecordLookup<T> {
    /** The record with this ID, or undefined when there is none. */
    get(id: Id): T | undefined;
    /** Whether a record with this ID exists. */
    has(id: Id): boolean;
    /** How many records there are. */
    readonly size: number;
    /** The records in insertion order; a replaced record keeps its place. */
    values(): IterableIterator<T>;
}
/**
 * An immutable table of records keyed by ID. Iteration follows insertion order. A table never
 * changes once made, so it can be held and shared freely; the records it holds are frozen.
 */
export declare class Table<T> implements RecordLookup<T> {
    #private;
    private constructor();
    /** A table with no records. */
    static empty<T>(): Table<T>;
    /** The record with this ID, or undefined when there is none. */
    get(id: Id): T | undefined;
    /** Whether a record with this ID exists. */
    has(id: Id): boolean;
    /** How many records the table holds. */
    get size(): number;
    /** The IDs in insertion order. */
    ids(): IterableIterator<Id>;
    /** The records in insertion order. */
    values(): IterableIterator<T>;
    /** The records in insertion order, as {@link Table.values} gives them. */
    [Symbol.iterator](): IterableIterator<T>;
    /**
     * A mutable working copy; the table itself is unchanged. The copy is the caller's: changing it
     * affects no workspace, and its {@link TableDraft.freeze} yields a separate table.
     */
    edit(): TableDraft<T>;
}
/**
 * A working copy of a table, used while a transaction is applied. It is mutable until
 * {@link TableDraft.freeze}, after which it refuses every change. It holds the same record
 * objects as the table it was copied from.
 */
export declare class TableDraft<T> implements RecordLookup<T> {
    #private;
    /**
     * A draft holding a copy of `entries`, in their order: changing what was given afterwards
     * changes neither the draft nor the table it freezes into.
     */
    constructor(entries?: Iterable<readonly [Id, T]>);
    /** The record with this ID, or undefined when there is none. */
    get(id: Id): T | undefined;
    /** Whether a record with this ID exists. */
    has(id: Id): boolean;
    /** How many records the draft holds. */
    get size(): number;
    /** The records in insertion order. */
    values(): IterableIterator<T>;
    /**
     * Adds the record, or replaces the one with this ID in its place. Throws an `Error` once the
     * draft is frozen.
     */
    set(id: Id, value: T): void;
    /** Removes the record with this ID, if any. Throws an `Error` once the draft is frozen. */
    delete(id: Id): void;
    /**
     * The finished table. The draft accepts no further changes; freezing it again throws an
     * `Error`.
     */
    freeze(): Table<T>;
}
//# sourceMappingURL=table.d.ts.map