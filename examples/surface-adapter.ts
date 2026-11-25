/**
 * A surface adapter for a host's own endpoints, checked by the conformance suite, in Node.js.
 *
 * The host here keeps documents by key; a surface shows one through its binding key. The adapter
 * only finds a document, says what its presentation can do, and puts it into or takes it out of a
 * container the framework hands it: the documents are the host's, and releasing a surface never
 * closes one.
 *
 *   npm run build:packages && node examples/surface-adapter.ts
 */
import { adapterConformance, runConformance } from '@swf/conformance';
import type { PresentationTarget, SurfaceAdapter, SurfaceCapabilities } from '@swf/surfaces';
import { ADAPTER_API_VERSION } from '@swf/surfaces';

/** A host document: its key, and the containers it is shown in. */
interface Document {
  readonly key: string;
  readonly shownIn: Set<unknown>;
}

const CAPABILITIES: SurfaceCapabilities = Object.freeze({
  attachStrategy: 'native-dom',
  nativeInteraction: 'full',
  uvAddressing: true,
  transformFidelity: 'approximate',
  transparency: false,
  clipping: true,
  cursorMapping: true,
  resize: 'spatial',
  viewportSharing: 'shared',
  safeDetach: true,
  rebinding: true,
  placeholder: false,
  snapshotHooks: false,
});

/** The error a resolution gives up with when the framework cancels it. */
function cancelled(signal: { readonly reason: unknown }): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('the binding was cancelled');
}

/**
 * An adapter over `documents`. A key the host does not know resolves to null (the surface stays
 * a placeholder); `broken/…` keys fail; `pending/…` keys answer only when the framework gives up
 * on them, through the abort signal.
 */
export function documentAdapter(
  documents: ReadonlyMap<string, Document>,
): SurfaceAdapter<Document> {
  return {
    id: 'host.document/1',
    apiVersion: ADAPTER_API_VERSION,
    declaredCapabilities: CAPABILITIES,
    resolve(key, signal) {
      if (signal.aborted) return Promise.reject(cancelled(signal));
      if (key.startsWith('broken/')) return Promise.reject(new Error(`document ${key} is damaged`));
      if (key.startsWith('pending/')) {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(cancelled(signal));
          });
        });
      }
      return Promise.resolve(documents.get(key) ?? null);
    },
    capabilities: () => CAPABILITIES,
    attach(document: Document, target: PresentationTarget) {
      document.shownIn.add(target.container);
    },
    // Hints are advice about visibility and attention: a document may use them, never must.
    update: () => undefined,
    detach(document: Document, target: PresentationTarget) {
      document.shownIn.delete(target.container);
    },
  };
}

/** Runs the conformance suite on the adapter, saying each case through `say`; returns them. */
export async function main(say: (line: string) => void = console.log) {
  const documents = new Map<string, Document>(
    ['report', 'budget'].map((key) => [key, { key, shownIn: new Set() }]),
  );
  const results = await runConformance(
    adapterConformance({
      create: () => documentAdapter(documents),
      keys: {
        valid: ['report', 'budget'],
        unknown: 'no-such-document',
        failing: 'broken/1',
        slow: 'pending/1',
      },
    }),
  );
  for (const r of results) {
    say(`${r.outcome.padEnd(14)} ${r.name}${r.message === null ? '' : `: ${r.message}`}`);
  }
  return results;
}

if (import.meta.main) {
  const results = await main();
  process.exitCode = results.some((r) => r.outcome === 'failed') ? 1 : 0;
}
