import type { SurfaceCapabilities } from '@swf/surfaces';
import { describe, expect, it } from 'vitest';
import type { AdapterFixture, MockHandle } from '../src/index.js';
import {
  adapterConformance,
  mockCapabilities,
  MockOpaqueAdapter,
  runConformance,
} from '../src/index.js';

/** A fixture over the reference mock, with every optional hook. */
function fixture(
  declared: SurfaceCapabilities,
  make: (declared: SurfaceCapabilities) => MockOpaqueAdapter = (d) =>
    new MockOpaqueAdapter('host.mock/1', d),
): AdapterFixture<MockHandle> {
  return {
    create() {
      const adapter = make(declared);
      adapter.unknown.add('ghost');
      adapter.failing.add('broken');
      adapter.holding.add('slow');
      return adapter;
    },
    keys: { valid: ['doc-1', 'doc-2'], unknown: 'ghost', failing: 'broken', slow: 'slow' },
    completeSlow: (adapter, key) => {
      (adapter as MockOpaqueAdapter).release(key);
    },
    changeCapabilities: (_adapter, context) => {
      context.announceCapabilities({ ...declared, transparency: false });
    },
    settleMs: 50,
  };
}

/** The names of the failed cases, each with the start of its message. */
async function failed(f: AdapterFixture<MockHandle>): Promise<string[]> {
  return (await runConformance(adapterConformance(f)))
    .filter((r) => r.outcome === 'failed')
    .map((r) => `${r.name} :: ${String(r.message)}`);
}

describe('adapter conformance suite', () => {
  it('passes the reference adapter in every case: single-owner, shared and unsafe alike', async () => {
    for (const declared of [
      mockCapabilities(),
      mockCapabilities({
        attachStrategy: 'drawable',
        nativeInteraction: 'none',
        viewportSharing: 'shared',
      }),
      mockCapabilities({ safeDetach: false, rebinding: false }),
    ]) {
      const results = await runConformance(adapterConformance(fixture(declared)));
      expect(results).toHaveLength(13);
      expect(results.filter((r) => r.outcome !== 'passed')).toEqual([]);
    }
  });

  it('reports the cases a fixture cannot exercise as not applicable', async () => {
    const minimal: AdapterFixture<MockHandle> = {
      create: () => {
        const adapter = new MockOpaqueAdapter('host.mock/1');
        adapter.unknown.add('ghost');
        return adapter;
      },
      keys: { valid: ['a', 'b'], unknown: 'ghost' },
    };
    const results = await runConformance(adapterConformance(minimal));
    expect(results.filter((r) => r.outcome === 'not-applicable').map((r) => r.name)).toEqual([
      'fails a failing key as a retryable error isolated to its surface',
      'gives up a binding that never answers when the timeout passes, aborting it',
      'stops resolving once its binding is cancelled',
      'has a late answer for a removed surface discarded, never attached',
      'announces only capability changes within its declaration',
    ]);
    expect(results.filter((r) => r.outcome === 'failed')).toEqual([]);
  });

  it('catches an adapter that fails an unknown key instead of answering null', async () => {
    const f = fixture(mockCapabilities(), (d) => {
      const adapter = new MockOpaqueAdapter('host.mock/1', d);
      adapter.failing.add('ghost');
      return adapter;
    });
    expect(await failed(f)).toEqual([
      expect.stringMatching(
        /^answers an unknown key with null.* :: an unknown key left the surface error/,
      ),
    ]);
  });

  it('catches an adapter that keeps resolving after its binding is cancelled', async () => {
    const f = fixture(
      mockCapabilities(),
      (d) => new MockOpaqueAdapter('host.mock/1', d, { ignoresAbort: true }),
    );
    expect(await failed(f)).toEqual([
      expect.stringMatching(
        /^stops resolving once its binding is cancelled :: the adapter kept resolving/,
      ),
    ]);
  });

  it('catches handles that claim more than the adapter declared', async () => {
    const f = fixture(
      mockCapabilities(),
      (d) =>
        new MockOpaqueAdapter('host.mock/1', d, {
          handleCapabilities: () => ({ ...d, viewportSharing: 'shared' }),
        }),
    );
    const messages = await failed(f);
    expect(messages).toHaveLength(8);
    expect(messages[0]).toMatch(
      /^binds a valid key.* :: key "doc-1" did not bind: .*exceed the declared capabilities \(viewportSharing\)/,
    );
  });

  it('catches contradictory declared capabilities in every case, starting at registration', async () => {
    const messages = await failed(fixture(mockCapabilities({ attachStrategy: 'drawable' })));
    expect(messages).toHaveLength(13);
    expect(messages[0]).toMatch(
      /^registers with a versioned contract.* :: .*native interaction requires the native-dom attach strategy/,
    );
  });

  it('catches capability changes beyond the declaration', async () => {
    const declared = mockCapabilities();
    const f: AdapterFixture<MockHandle> = {
      ...fixture(declared),
      changeCapabilities: (_adapter, context) => {
        context.announceCapabilities({ ...declared, viewportSharing: 'shared' });
      },
    };
    expect(await failed(f)).toEqual([
      expect.stringMatching(
        /^announces only capability changes within its declaration :: the announced capabilities were refused/,
      ),
    ]);
  });

  it('catches an adapter that cannot mount its endpoints', async () => {
    const f = fixture(mockCapabilities(), (d) => {
      const adapter = new MockOpaqueAdapter('host.mock/1', d);
      adapter.attachFailing.add('doc-1');
      return adapter;
    });
    const messages = await failed(f);
    expect(messages).toContainEqual(
      expect.stringMatching(
        /^is detached with exactly the handle and target .* :: presenting failed/,
      ),
    );
    expect(messages).toContainEqual(
      expect.stringMatching(
        /^goes through its lifecycle with events in order :: events were .*ready>error/,
      ),
    );
  });
});
