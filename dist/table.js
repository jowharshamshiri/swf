/**
 * Makes a table over `map`, which nothing else may hold or change. Private to this module: only
 * {@link TableDraft.freeze} calls it, handing over the map of a draft that refuses every change
 * from then on.
 */
let tableOver;
/**
 * An immutable table of records keyed by ID. Iteration follows insertion order. A table never
 * changes once made, so it can be held and shared freely; the records it holds are frozen.
 */
export class Table {
    #map;
    constructor(map) {
        this.#map = map;
        Object.freeze(this);
    }
    static {
        tableOver = (map) => new Table(map);
    }
    /** A table with no records. */
    static empty() {
        return new Table(new Map());
    }
    /** The record with this ID, or undefined when there is none. */
    get(id) {
        return this.#map.get(id);
    }
    /** Whether a record with this ID exists. */
    has(id) {
        return this.#map.has(id);
    }
    /** How many records the table holds. */
    get size() {
        return this.#map.size;
    }
    /** The IDs in insertion order. */
    ids() {
        return this.#map.keys();
    }
    /** The records in insertion order. */
    values() {
        return this.#map.values();
    }
    /** The records in insertion order, as {@link Table.values} gives them. */
    [Symbol.iterator]() {
        return this.#map.values();
    }
    /**
     * A mutable working copy; the table itself is unchanged. The copy is the caller's: changing it
     * affects no workspace, and its {@link TableDraft.freeze} yields a separate table.
     */
    edit() {
        return new TableDraft(this.#map);
    }
}
/**
 * A working copy of a table, used while a transaction is applied. It is mutable until
 * {@link TableDraft.freeze}, after which it refuses every change. It holds the same record
 * objects as the table it was copied from.
 */
export class TableDraft {
    #map;
    #frozen = false;
    /**
     * A draft holding a copy of `entries`, in their order: changing what was given afterwards
     * changes neither the draft nor the table it freezes into.
     */
    constructor(entries = []) {
        this.#map = new Map(entries);
    }
    /** The record with this ID, or undefined when there is none. */
    get(id) {
        return this.#map.get(id);
    }
    /** Whether a record with this ID exists. */
    has(id) {
        return this.#map.has(id);
    }
    /** How many records the draft holds. */
    get size() {
        return this.#map.size;
    }
    /** The records in insertion order. */
    values() {
        return this.#map.values();
    }
    /**
     * Adds the record, or replaces the one with this ID in its place. Throws an `Error` once the
     * draft is frozen.
     */
    set(id, value) {
        this.#assertOpen();
        this.#map.set(id, value);
    }
    /** Removes the record with this ID, if any. Throws an `Error` once the draft is frozen. */
    delete(id) {
        this.#assertOpen();
        this.#map.delete(id);
    }
    /**
     * The finished table. The draft accepts no further changes; freezing it again throws an
     * `Error`.
     */
    freeze() {
        this.#assertOpen();
        this.#frozen = true;
        return tableOver(this.#map);
    }
    #assertOpen() {
        if (this.#frozen) {
            throw new Error('table draft was already frozen');
        }
    }
}
//# sourceMappingURL=table.js.map