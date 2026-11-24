import { describe, expect, it } from 'vitest';
import { fromJson, toJson } from '../src/index.js';

describe('JSON values for the models', () => {
  it('carries every JSON value across and back, objects in their order', () => {
    const value = { b: [1, 'two', null, true, { c: -0.5 }], a: {} };
    const json = toJson(value);
    expect(json).toEqual({
      kind: 'obj',
      members: [
        [
          'b',
          {
            kind: 'arr',
            items: [
              { kind: 'num', value: 1 },
              { kind: 'str', value: 'two' },
              { kind: 'null' },
              { kind: 'bool', value: true },
              { kind: 'obj', members: [['c', { kind: 'num', value: -0.5 }]] },
            ],
          },
        ],
        ['a', { kind: 'obj', members: [] }],
      ],
    });
    const back = fromJson(json);
    expect(back).toEqual(value);
    expect(Object.keys(back as object)).toEqual(['b', 'a']);
    expect(Object.isFrozen(back)).toBe(true);
  });

  it('passes non-finite numbers on for the model to refuse', () => {
    expect(toJson(Number.NaN)).toEqual({ kind: 'num', value: Number.NaN });
    expect(toJson(-Infinity)).toEqual({ kind: 'num', value: -Infinity });
  });

  it('refuses what JSON has no value for, saying where it is', () => {
    expect(() => toJson({ a: [1, undefined] }, 'patch')).toThrow(
      new TypeError('patch.a[1] has no JSON value (it is undefined)'),
    );
    expect(() => toJson({ f: () => 1 })).toThrow('value.f has no JSON value (it is function)');
    expect(() => toJson(1n)).toThrow('value has no JSON value (it is bigint)');
    const cycle: Record<string, unknown> = {};
    cycle['self'] = [cycle];
    expect(() => toJson(cycle)).toThrow('value.self[0] has no JSON value (it contains itself)');
    // A value reached twice without a cycle is fine.
    const shared = { x: 1 };
    expect(fromJson(toJson([shared, shared]))).toEqual([{ x: 1 }, { x: 1 }]);
  });
});
