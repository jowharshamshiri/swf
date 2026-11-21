import { describe, expect, it } from 'vitest';
import type { HandoffFixture } from '../src/index.js';
import {
  handoffConformance,
  MockCompositor,
  MockCompositorSession,
  MockRenderer,
  runConformance,
} from '../src/index.js';
import type { MockRendererSession } from '../src/index.js';

/** The reference backend under its own IDs, losing its context as a mock session does. */
function reference(over: Partial<HandoffFixture> = {}): HandoffFixture {
  return {
    renderer: () => new MockRenderer('tested.renderer/1'),
    compositor: () => new MockCompositor('tested.compositor/1'),
    loseContext: ({ compositor }) => {
      if (!(compositor instanceof MockCompositorSession)) {
        throw new Error('not a mock compositor session');
      }
      compositor.lose('context lost');
    },
    ...over,
  };
}

const outcomes = async (fixture: HandoffFixture) =>
  (await runConformance(handoffConformance(fixture))).map((r) =>
    r.outcome === 'failed' ? `${r.name} :: ${String(r.message)}` : r.outcome,
  );

describe('handoff conformance suite (QA-005 runtime cases)', () => {
  it('passes the reference backend in every case', async () => {
    expect(await outcomes(reference())).toEqual(['passed', 'passed', 'passed', 'passed']);
  });

  it('does not apply the loss case to a backend that holds nothing it can lose', async () => {
    const lossless: HandoffFixture = {
      renderer: () => new MockRenderer('tested.renderer/1'),
      compositor: () => new MockCompositor('tested.compositor/1'),
    };
    expect(await outcomes(lossless)).toEqual(['passed', 'passed', 'not-applicable', 'passed']);
  });

  it('catches a backend that never reports losing its context', async () => {
    const silent = reference({
      loseContext: () => {
        // The context goes, but the backend says nothing.
      },
    });
    expect((await outcomes(silent))[2]).toMatch(/was not reported as a lost backend/);
  });

  it('catches a renderer that gives live content nowhere to go', async () => {
    class Nowhere extends MockRenderer {
      override async prepare(...args: Parameters<MockRenderer['prepare']>) {
        const session = (await super.prepare(...args)) as MockRendererSession;
        session.targetOf = () => undefined;
        return session;
      }
    }
    const results = await outcomes(reference({ renderer: () => new Nowhere('tested.renderer/1') }));
    expect(results[0]).toMatch(/the switch to the backend under test did not happen/);
  });
});
