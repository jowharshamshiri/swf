import { SwfFailure } from '@swf/core';
import { describe, expect, it } from 'vitest';
import { jsonSyntaxError, parseJson } from '../src/index.js';

describe('JSON syntax errors (FR-201)', () => {
  it('accepts valid JSON of every kind', () => {
    for (const text of [
      '{}',
      '[]',
      ' { "a" : [1, -2.5e+3, 0.1, true, false, null, "x\\u00e9\\n"] } ',
      '"text"',
      '0',
    ]) {
      expect(jsonSyntaxError(text)).toBeNull();
      expect(() => JSON.parse(text) as unknown).not.toThrow();
    }
  });

  it('finds the first break, by line and column, and what was expected there', () => {
    expect(jsonSyntaxError('{\n  "a": 1,\n  "b" 2\n}')).toEqual({
      offset: 18,
      line: 3,
      column: 7,
      expected: 'a colon (:)',
    });
    expect(jsonSyntaxError('[1, 2,]')).toMatchObject({ line: 1, column: 7, expected: 'a value' });
    expect(jsonSyntaxError('{"a": 1')).toMatchObject({
      column: 8,
      expected: 'a comma (,) or the end of the object (})',
    });
    expect(jsonSyntaxError('{"a": 01}')).toMatchObject({ column: 8 });
    expect(jsonSyntaxError('"\\x"')).toMatchObject({ column: 3, expected: 'an escape character' });
    expect(jsonSyntaxError('{} {}')).toMatchObject({ column: 4, expected: 'the end of the text' });
    expect(jsonSyntaxError('')).toMatchObject({ line: 1, column: 1, expected: 'a value' });
    // Whatever the engine's own parser refuses, the locator refuses too.
    for (const text of ['{"a": 01}', "{'a': 1}", '[1,]', 'nul', '{"a":1,}', '"\t"']) {
      expect(() => JSON.parse(text) as unknown).toThrow();
      expect(jsonSyntaxError(text)).not.toBeNull();
    }
  });

  it('says in a refused snapshot where its text breaks', () => {
    let caught: unknown;
    try {
      parseJson('{\n  "schema": "swf.workspace/1",\n  "nodes": [,]\n}');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SwfFailure);
    expect((caught as SwfFailure).error).toMatchObject({
      code: 'SNAPSHOT_INVALID',
      message: 'the snapshot is not JSON: at line 3, column 13, a value was expected',
      details: { line: 3, column: 13 },
    });
  });
});
