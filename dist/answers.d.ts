/**
 * Whether a hook that must answer synchronously answered with a promise (any thenable). Its
 * outcome is then handled here, so a rejection it carries is never left unhandled; the caller
 * reports the hook's answer as a failure.
 */
export declare function answeredWithPromise(value: unknown): boolean;
/** What a hook answered, in words, for a message: `undefined`, `null`, `a promise`, `a string`. */
export declare function describeAnswer(value: unknown): string;
//# sourceMappingURL=answers.d.ts.map