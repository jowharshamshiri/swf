/** Seeds are unsigned 32-bit integers. */
export const MAX_SEED = 0xffff_ffff;
/** Why `seed` is not a valid seed (an integer from 0 to {@link MAX_SEED}), or null when it is. */
export function seedIssue(seed) {
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
        return `a seed must be an integer from 0 to ${String(MAX_SEED)}`;
    }
    return null;
}
/**
 * A generator started from `seed`. The generator is frozen, and its state is its own: two made
 * from the same seed give the same sequence independently.
 *
 * @throws RangeError when the seed is not an integer from 0 to {@link MAX_SEED}, with the reason
 *   {@link seedIssue} gives.
 */
export function createRandom(seed) {
    const issue = seedIssue(seed);
    if (issue !== null) {
        throw new RangeError(`${issue} (got ${String(seed)})`);
    }
    let state = seed;
    const next = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    return Object.freeze({
        next,
        range: (min, max) => min + (max - min) * next(),
        integer: (min, max) => min + Math.floor((max - min + 1) * next()),
    });
}
//# sourceMappingURL=random.js.map