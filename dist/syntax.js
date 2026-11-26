class Broken extends Error {
    offset;
    expected;
    constructor(offset, expected) {
        super(expected);
        this.offset = offset;
        this.expected = expected;
    }
}
const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
/** The first syntax error in `text`, or null when it is valid JSON. The result is frozen. */
export function jsonSyntaxError(text) {
    let at = 0;
    const peek = () => text[at];
    const skip = () => {
        while (at < text.length && WHITESPACE.has(text[at] ?? '')) {
            at += 1;
        }
    };
    const expect = (char, what) => {
        if (text[at] !== char) {
            throw new Broken(at, what);
        }
        at += 1;
    };
    const literal = (word) => {
        if (!text.startsWith(word, at)) {
            throw new Broken(at, 'a value');
        }
        at += word.length;
    };
    const digits = (what) => {
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
        }
        else {
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
    const scalar = (char) => {
        if (char === '"') {
            string();
        }
        else if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) {
            number();
        }
        else if (char === 't') {
            literal('true');
        }
        else if (char === 'f') {
            literal('false');
        }
        else if (char === 'n') {
            literal('null');
        }
        else {
            throw new Broken(at, 'a value');
        }
    };
    const member = () => {
        skip();
        string();
        skip();
        expect(':', 'a colon (:)');
    };
    // One value, read without recursion: the arrays and objects still open are kept on a stack of
    // their own, so text nested deeper than the call stack is read like any other.
    const value = () => {
        const open = [];
        for (;;) {
            skip();
            const char = peek();
            if (char === '{' || char === '[') {
                const close = char === '{' ? '}' : ']';
                at += 1;
                skip();
                if (peek() === close) {
                    at += 1;
                }
                else {
                    open.push(char);
                    if (char === '{') {
                        member();
                    }
                    continue;
                }
            }
            else {
                scalar(char);
            }
            // A value is complete: it ends the containers it closes, or one of them goes on.
            for (;;) {
                const container = open.at(-1);
                if (container === undefined) {
                    return;
                }
                skip();
                if (peek() === ',') {
                    at += 1;
                    if (container === '{') {
                        member();
                    }
                    break;
                }
                if (container === '{') {
                    expect('}', 'a comma (,) or the end of the object (})');
                }
                else {
                    expect(']', 'a comma (,) or the end of the array (])');
                }
                open.pop();
            }
        }
    };
    try {
        value();
        skip();
        if (at < text.length) {
            throw new Broken(at, 'the end of the text');
        }
        return null;
    }
    catch (error) {
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
//# sourceMappingURL=syntax.js.map