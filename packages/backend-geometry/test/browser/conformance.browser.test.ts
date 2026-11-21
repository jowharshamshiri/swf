import { DomCompositor, DomRenderer } from '@swf/backend-dom';
import type { BackendFixture, HandoffFixture } from '@swf/conformance';
import { backendConformance, handoffConformance, runConformance } from '@swf/conformance';
import { afterEach, describe, expect, it } from 'vitest';
import type { LayerCompositorSession } from '../../src/index.js';
import { GeometryRenderer, LayerCompositor, LayeredRenderer } from '../../src/index.js';

const containers: HTMLElement[] = [];
afterEach(() => {
  containers.splice(0).forEach((c) => {
    c.remove();
  });
});

function container(): HTMLElement {
  const c = document.createElement('div');
  document.body.append(c);
  containers.push(c);
  return c;
}

/** A small drawable that never changes: what a `drawable` adapter hands the geometry renderer. */
function drawables() {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.fillStyle = 'rgb(0, 160, 0)';
    ctx.fillRect(0, 0, 16, 16);
  }
  return () => ({ source: canvas, width: 16, height: 16, revision: 1 });
}

const IMPLEMENTATIONS: Record<string, BackendFixture> = {
  'the DOM backend': {
    renderer: () => new DomRenderer({ document }),
    compositor: () => new DomCompositor(),
    container,
  },
  'the geometry backend': {
    renderer: () => new GeometryRenderer({ drawables: drawables() }),
    compositor: () => new LayerCompositor(),
    container,
  },
  'the DOM and geometry backends layered': {
    renderer: () =>
      new LayeredRenderer({
        native: new DomRenderer({ document }),
        geometry: new GeometryRenderer({ drawables: drawables() }),
      }),
    compositor: () => new LayerCompositor(),
    container,
  },
};

/** Takes a drawn layer's 2D context away, as the browser does under memory pressure. */
const loseCanvas: HandoffFixture['loseContext'] = ({ compositor }) => {
  const canvas = (compositor as LayerCompositorSession).root.querySelector('canvas');
  if (canvas === null) {
    throw new Error('the geometry backend drew no canvas to lose');
  }
  canvas.dispatchEvent(new Event('contextlost'));
};

const HANDOFF: Record<string, { fixture: HandoffFixture; loses: boolean }> = {
  'the DOM backend': {
    fixture: {
      renderer: () => new DomRenderer({ document }),
      compositor: () => new DomCompositor(),
      container,
    },
    loses: false,
  },
  'the geometry backend': {
    fixture: {
      renderer: () => new GeometryRenderer({ drawables: drawables() }),
      compositor: () => new LayerCompositor(),
      container,
      loseContext: loseCanvas,
    },
    loses: true,
  },
  'the DOM and geometry backends layered': {
    fixture: {
      renderer: () =>
        new LayeredRenderer({
          native: new DomRenderer({ document }),
          geometry: new GeometryRenderer({ drawables: drawables() }),
        }),
      compositor: () => new LayerCompositor(),
      container,
      loseContext: loseCanvas,
    },
    loses: true,
  },
};

describe('one conformance suite, independent implementations (FR-090, AC-013, QA-005)', () => {
  for (const [name, fixture] of Object.entries(IMPLEMENTATIONS)) {
    it(`passes with ${name}`, async () => {
      const results = await runConformance(backendConformance(fixture));
      expect(results.length).toBeGreaterThan(5);
      expect(results.filter((r) => r.outcome !== 'passed')).toEqual([]);
      // Released sessions leave nothing behind.
      expect(containers.every((c) => c.childElementCount === 0)).toBe(true);
    });
  }

  for (const [name, { fixture, loses }] of Object.entries(HANDOFF)) {
    it(`passes the runtime cases with ${name}: handoffs, rollback, context loss and visible fallback`, async () => {
      const results = await runConformance(handoffConformance(fixture));
      expect(results.map((r) => (r.outcome === 'failed' ? r.message : r.outcome))).toEqual([
        'passed',
        'passed',
        loses ? 'passed' : 'not-applicable',
        'passed',
      ]);
      expect(containers.every((c) => c.childElementCount === 0)).toBe(true);
    });
  }
});
