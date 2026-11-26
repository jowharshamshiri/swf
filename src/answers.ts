/**
 * Whether a hook that must answer synchronously answered with a promise (any thenable). Its
 * outcome is then handled here, so a rejection it carries is never left unhandled; the caller
 * reports the hook's answer as a failure.
 */
export function answeredWithPromise(value: unknown): boolean {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    typeof (value as { then?: unknown }).then !== 'function'
  ) {
    return false;
  }
  Promise.resolve(value).catch(() => undefined);
  return true;
}

/** What a hook answered, in words, for a message: `undefined`, `null`, `a promise`, `a string`. */
export function describeAnswer(value: unknown): string {
  if (value === undefined || value === null) {
    return String(value);
  }
  if (answeredWithPromise(value)) {
    return 'a promise';
  }
  const type = Array.isArray(value) ? 'array' : typeof value;
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}
