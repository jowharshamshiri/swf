import { backendConformance, runConformance } from '@swf/conformance';
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
});
