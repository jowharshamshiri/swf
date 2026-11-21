import { backendConformance, handoffConformance, runConformance } from '@swf/conformance';
import { describe, expect, it } from 'vitest';
import { DomCompositor, DomRenderer } from '../../src/index.js';

describe('DOM backend conformance (QA-005)', () => {
  it('passes every renderer and compositor case in a real browser', async () => {
    const containers: HTMLElement[] = [];
    const results = await runConformance(
      backendConformance({
        renderer: () => new DomRenderer({ document }),
        compositor: () => new DomCompositor(),
        container: () => {
          const container = document.createElement('div');
          document.body.append(container);
          containers.push(container);
          return container;
        },
      }),
    );
    expect(results.length).toBeGreaterThan(5);
    expect(results.filter((r) => r.outcome !== 'passed')).toEqual([]);
    // Every session released its view: nothing is left in the containers.
    expect(containers.every((c) => c.childElementCount === 0)).toBe(true);
    containers.forEach((c) => {
      c.remove();
    });
  });

  it('passes the runtime cases: handoffs, rollback and visible fallback, in a real browser', async () => {
    const containers: HTMLElement[] = [];
    const results = await runConformance(
      handoffConformance({
        renderer: () => new DomRenderer({ document }),
        compositor: () => new DomCompositor(),
        container: () => {
          const container = document.createElement('div');
          document.body.append(container);
          containers.push(container);
          return container;
        },
      }),
    );
    // DOM elements are never lost, so the loss case does not apply; every other case passes.
    expect(results.map((r) => (r.outcome === 'failed' ? r.message : r.outcome))).toEqual([
      'passed',
      'passed',
      'not-applicable',
      'passed',
    ]);
    expect(containers.every((c) => c.childElementCount === 0)).toBe(true);
    containers.forEach((c) => {
      c.remove();
    });
  });
});
