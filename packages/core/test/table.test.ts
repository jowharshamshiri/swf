import { describe, expect, it } from 'vitest';
import { Table, TableDraft } from '../src/table.js';

describe('tables', () => {
  it('never change through a map their maker kept', () => {
    const map = new Map<string, number>([['a', 1]]);
    const table = new TableDraft(map).freeze();
    map.set('b', 2);
    map.delete('a');
    expect([...table.ids()]).toEqual(['a']);
    expect(table.get('a')).toBe(1);
  });

  it('offer no static factory that wraps a map the caller keeps', () => {
    const statics = Object.getOwnPropertyNames(Table).filter(
      (name) => typeof (Table as unknown as Record<string, unknown>)[name] === 'function',
    );
    expect(statics.length).toBeGreaterThan(0);
    for (const name of statics) {
      const map = new Map<string, number>();
      const made: unknown = (Table as unknown as Record<string, (m: unknown) => unknown>)[name]?.(
        map,
      );
      if (!(made instanceof Table)) {
        continue;
      }
      const size = made.size;
      map.set('x', 1);
      expect(made.size, `Table.${name}`).toBe(size);
      expect(made.has('x'), `Table.${name}`).toBe(false);
    }
  });

  it('keep an edited copy apart from the table it came from', () => {
    const table = new TableDraft(new Map([['a', 1]])).freeze();
    const draft = table.edit();
    draft.set('b', 2);
    expect(table.has('b')).toBe(false);
    expect(draft.freeze().has('b')).toBe(true);
  });
});
