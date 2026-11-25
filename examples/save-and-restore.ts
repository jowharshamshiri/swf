/**
 * Saving a layout and bringing it back, in Node.js: a workspace and an extension's own state
 * saved to a store through a saver, restored into a fresh workspace whose surfaces come back as
 * placeholders keeping their binding keys, and a damaged export refused with the place it breaks.
 *
 *   npm run build:packages && node examples/save-and-restore.ts
 */
import { createWorkspace, SwfFailure } from '@swf/core';
import { createMemoryStore, createPersistence, createSaver } from '@swf/persistence';
import { createSurfaceRuntime } from '@swf/surfaces';

/** Runs the example, saying each step through `say`; returns what came back. */
export async function main(say: (line: string) => void = console.log) {
  const store = createMemoryStore();

  // --- The first session: a layout and an extension's notes, saved. -------------------------
  const first = createWorkspace({ id: 'desk' });
  first.transaction([
    {
      type: 'node.create',
      node: {
        id: 'notes',
        kind: 'window',
        bounds: [1.6, 0.9, 0.01],
        transform: { position: [0, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        label: 'Notes',
      },
    },
    {
      type: 'surface.attach',
      surface: {
        id: 'notes-view',
        ownerNodeId: 'notes',
        bindingKey: 'editor-42',
        adapterTypeId: 'host.editor/1',
        bounds: [1.6, 0.9, 0.01],
      },
    },
  ]);
  let pinned = ['editor-42'];
  const persistence = createPersistence({ workspace: first.persistence() });
  // The extension's state is opaque to the framework: JSON it captures and takes back.
  persistence.registerExtension({
    namespace: 'ext.pins',
    version: 1,
    capture: () => ({ pinned }),
    restore: () => undefined,
  });
  const saver = createSaver({ persistence, store, key: 'main' });
  const saved = await saver.save();
  say(`saved: ${saved.status}, the saver is ${saver.state}`);
  const exported = persistence.export((await persistence.capture()).document);
  saver.dispose();
  persistence.dispose();
  await first.dispose();

  // --- The next session: restore from the store. --------------------------------------------
  const second = createWorkspace({ id: 'desk' });
  // No adapter is registered for host.editor/1 yet, so its surface waits as a placeholder.
  const surfaces = createSurfaceRuntime(second);
  const restoring = createPersistence({ workspace: second.persistence() });
  restoring.registerExtension({
    namespace: 'ext.pins',
    version: 1,
    capture: () => ({ pinned }),
    restore: (data) => {
      pinned = (data as { pinned: string[] }).pinned;
    },
  });
  const stored = await store.load('main');
  if (stored === null) throw new Error('the store lost the layout');
  const outcome = await restoring.restore(stored.document);
  if (outcome.status !== 'restored') {
    throw new Error(`restore refused: ${outcome.error.code} at ${String(outcome.error.path)}`);
  }
  const surface = surfaces.list().find((s) => s.surfaceId === 'notes-view');
  say(
    `restored revision ${String(second.getState().revision)}; notes-view is ${String(surface?.state)} with key ${String(second.getState().surfaces.get('notes-view')?.bindingKey)}`,
  );
  say(`the extension took back its pins: ${pinned.join(', ')}`);

  // --- A damaged export is refused, naming where it breaks. ---------------------------------
  let refusal = '';
  try {
    restoring.import(exported.slice(0, 40));
  } catch (error) {
    if (!(error instanceof SwfFailure)) throw error;
    const { code, details } = error.error;
    refusal = `${code} at line ${String(details?.['line'])}, column ${String(details?.['column'])}`;
  }
  say(`a cut-short export: ${refusal}`);

  const facts = {
    saved: saved.status,
    restored: outcome.status,
    surfaceState: surface?.state ?? null,
    bindingKey: second.getState().surfaces.get('notes-view')?.bindingKey ?? null,
    pinned,
    refusal,
  };
  restoring.dispose();
  await surfaces.dispose();
  await second.dispose();
  return facts;
}

if (import.meta.main) await main();
