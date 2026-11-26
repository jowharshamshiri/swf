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
/** The first syntax error in `text`, or null when it is valid JSON. The result is frozen. */
export declare function jsonSyntaxError(text: string): JsonSyntaxError | null;
//# sourceMappingURL=syntax.d.ts.map