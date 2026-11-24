import { describe, expect, it } from 'vitest';
import { ASSURANCE, models } from '../src/index.js';

/**
 * What lungo carries from the Lean models into the program: every export the packages call is the
 * subject of a claim proved without `sorry` and without an axiom beyond Lean's standard three, and
 * nothing they decide is left to the host (no facility).
 */
const STANDARD_AXIOMS = ['Classical.choice', 'propext', 'Quot.sound'];

describe('the models program', () => {
  it('is the one lungo generated from the Lean models', () => {
    expect(ASSURANCE.program).toBe('swf-models');
    expect(ASSURANCE.provenance.lean_version).toBe('4.35.0');
    expect(ASSURANCE.provenance.lungo_version).toBe('1.127.0');
  });

  it('has a proved claim for every export, resting on nothing but Lean', () => {
    const claims = new Map(ASSURANCE.claims.map((c) => [c.name, c]));
    expect(ASSURANCE.exports.length).toBeGreaterThan(0);
    for (const exported of ASSURANCE.exports) {
      expect(exported.claims, exported.name).not.toEqual([]);
      expect(exported.trust.depends_on_sorry, exported.name).toBe(false);
      expect(exported.facilities, exported.name).toEqual([]);
      expect(exported.assumptions, exported.name).toEqual([]);
      for (const name of exported.claims) {
        const claim = claims.get(name);
        expect(claim?.status, name).toBe('proved');
        expect(claim?.evidence_trust.depends_on_sorry, name).toBe(false);
        for (const axiom of claim?.evidence_trust.axioms ?? []) {
          expect(STANDARD_AXIOMS, `${name} rests on ${axiom}`).toContain(axiom);
        }
      }
    }
  });

  it('exports a method for every export the assurance names, and calls into it', () => {
    for (const exported of ASSURANCE.exports) {
      const method = exported.name.split('.').at(-1) ?? '';
      expect(typeof (models as unknown as Record<string, unknown>)[method], exported.name).toBe(
        'function',
      );
    }
    expect(models.lockRefuses(true, true)).toBe(true);
    expect(models.lockRefuses(false, true)).toBe(false);
  });
});
