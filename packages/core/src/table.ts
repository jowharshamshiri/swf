import type { Id } from './model.js';

/** Read access to records by ID, in a stable insertion order. */
export interface RecordLookup<T> {
  get(id: Id): T | undefined;
  has(id: Id): boolean;
  readonly size: number;
  values(): IterableIterator<T>;
}

/** An immutable table of records keyed by ID. Iteration follows insertion order. */
export class Table<T> implements RecordLookup<T> {
  readonly #map: ReadonlyMap<Id, T>;

  private constructor(map: ReadonlyMap<Id, T>) {
    this.#map = map;
    Object.freeze(this);
  }

  static empty<T>(): Table<T> {
    return new Table<T>(new Map<Id, T>());
  }

  get(id: Id): T | undefined {
    return this.#map.get(id);
  }

  has(id: Id): boolean {
    return this.#map.has(id);
  }

  get size(): number {
    return this.#map.size;
  }

  ids(): IterableIterator<Id> {
    return this.#map.keys();
  }

  values(): IterableIterator<T> {
    return this.#map.values();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.#map.values();
  }

  /** A mutable working copy; the table itself is unchanged. */
  edit(): TableDraft<T> {
    return new TableDraft(new Map(this.#map));
  }

  /** @internal Used by {@link TableDraft.freeze}. */
  static fromMap<T>(map: Map<Id, T>): Table<T> {
    return new Table(map);
  }
}

/** A working copy of a table, used while a transaction is applied. */
export class TableDraft<T> implements RecordLookup<T> {
  readonly #map: Map<Id, T>;
  #frozen = false;

  constructor(map: Map<Id, T>) {
    this.#map = map;
  }

  get(id: Id): T | undefined {
    return this.#map.get(id);
  }

  has(id: Id): boolean {
    return this.#map.has(id);
  }

  get size(): number {
    return this.#map.size;
  }

  values(): IterableIterator<T> {
    return this.#map.values();
  }

  set(id: Id, value: T): void {
    this.#assertOpen();
    this.#map.set(id, value);
  }

  delete(id: Id): void {
    this.#assertOpen();
    this.#map.delete(id);
  }

  /** The finished table. The draft accepts no further changes. */
  freeze(): Table<T> {
    this.#assertOpen();
    this.#frozen = true;
    return Table.fromMap(this.#map);
  }

  #assertOpen(): void {
    if (this.#frozen) {
      throw new Error('table draft was already frozen');
    }
  }
}
