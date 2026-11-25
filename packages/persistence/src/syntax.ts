/**
 * Where JSON text first breaks the JSON grammar (RFC 8259), found by reading it once: the same
 * answer in every engine, whatever its own parser says. Used only after `JSON.parse` has refused
 * the text, to tell the operator the line and column to look at.
 */
export interface JsonSyntaxError {
  /** UTF-16 offset of the first character that cannot be there. */
  readonly offset: number;
  /** 1-based line of that character; lines end at each `\n`. */
  readonly line: number;
  /** 1-based column of that character, in UTF-16 units from the start of its line. */
  readonly column: number;
  /** What the grammar needed there, in words, such as `a colon (:)`. */
  readonly expected: string;
}

class Broken extends Error {
  constructor(
    readonly offset: number,
    readonly expected: string,
  ) {
    super(expected);
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/** The first syntax error in `text`, or null when it is valid JSON. The result is frozen. */
export function jsonSyntaxError(text: string): JsonSyntaxError | null {
  let at = 0;
  const peek = () => text[at];
  const skip = () => {
    while (at < text.length && WHITESPACE.has(text[at] ?? '')) {
      at += 1;
    }
  };
  const expect = (char: string, what: string) => {
    if (text[at] !== char) {
      throw new Broken(at, what);
    }
    at += 1;
  };
  const literal = (word: string) => {
    if (!text.startsWith(word, at)) {
      throw new Broken(at, 'a value');
    }
    at += word.length;
  };
  const digits = (what: string) => {
    const start = at;
    while (at < text.length && /[0-9]/.test(text[at] ?? '')) {
      at += 1;
    }
    if (at === start) {
      throw new Broken(at, what);
    }
  };
  const number = () => {
    if (peek() === '-') {
      at += 1;
    }
    if (peek() === '0') {
      at += 1;
    } else {
      digits('a digit');
    }
    if (peek() === '.') {
      at += 1;
      digits('a digit after the decimal point');
    }
    if (peek() === 'e' || peek() === 'E') {
      at += 1;
      if (peek() === '+' || peek() === '-') {
        at += 1;
      }
      digits('a digit of the exponent');
    }
  };
  const string = () => {
    expect('"', 'a string');
    for (;;) {
      const char = peek();
      if (char === undefined) {
        throw new Broken(at, 'the end of the string (")');
      }
      if (char === '"') {
        at += 1;
        return;
      }
      if (char < ' ') {
        throw new Broken(at, 'a character that is not a control character, or an escape');
      }
      if (char === '\\') {
        at += 1;
        const escaped = peek();
        if (escaped === 'u') {
          at += 1;
          for (let i = 0; i < 4; i += 1) {
            if (!/[0-9a-fA-F]/.test(peek() ?? '')) {
              throw new Broken(at, 'a hexadecimal digit');
            }
            at += 1;
          }
          continue;
        }
        if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) {
          throw new Broken(at, 'an escape character');
        }
      }
      at += 1;
    }
  };
  const value = (): void => {
    skip();
    const char = peek();
    if (char === '{') {
      at += 1;
      skip();
      if (peek() === '}') {
        at += 1;
        return;
      }
      for (;;) {
        skip();
        string();
        skip();
        expect(':', 'a colon (:)');
        value();
        skip();
        if (peek() === ',') {
          at += 1;
          continue;
        }
        expect('}', 'a comma (,) or the end of the object (})');
        return;
      }
    }
    if (char === '[') {
      at += 1;
      skip();
      if (peek() === ']') {
        at += 1;
        return;
      }
      for (;;) {
        value();
        skip();
        if (peek() === ',') {
          at += 1;
          continue;
        }
        expect(']', 'a comma (,) or the end of the array (])');
        return;
      }
    }
    if (char === '"') {
      string();
    } else if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) {
      number();
    } else if (char === 't') {
      literal('true');
    } else if (char === 'f') {
      literal('false');
    } else if (char === 'n') {
      literal('null');
    } else {
      throw new Broken(at, 'a value');
    }
  };
  try {
    value();
    skip();
    if (at < text.length) {
      throw new Broken(at, 'the end of the text');
    }
    return null;
  } catch (error) {
    if (!(error instanceof Broken)) {
      throw error;
    }
    const before = text.slice(0, error.offset);
    const lineStart = before.lastIndexOf('\n') + 1;
    return Object.freeze({
      offset: error.offset,
      line: before.split('\n').length,
      column: error.offset - lineStart + 1,
      expected: error.expected,
    });
  }
}
