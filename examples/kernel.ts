/**
 * The scene kernel on its own, in Node.js: windows and a surface made in one transaction, a
 * refused transaction that changes nothing, a group, undo and redo, idempotent retries, the events
 * each step announces, and disposal.
 *
 *   npm run build:packages && node examples/kernel.ts
 */
import type { TxResult, Workspace } from '@swf/core';
import { createWorkspace, worldMatrix } from '@swf/core';

/** A window spec: 1.6 × 0.9 units, `z` units ahead of the camera along -Z. */
function windowSpec(id: string, x: number, z: number) {
  return {
    id,
    kind: 'window',
    bounds: [1.6, 0.9, 0.01] as const,
    transform: {
      position: [x, 0, z] as const,
      rotation: [0, 0, 0, 1] as const,
      scale: [1, 1, 1] as const,
    },
    label: id,
  };
}

/** The outcome of a transaction, or the error it was refused with. */
function outcome(result: TxResult): string {
  switch (result.status) {
    case 'committed':
      return `committed revision ${String(result.revision)}`;
    case 'rejected':
      return `rejected ${result.error.code} at ${String(result.error.path)}: ${result.error.message}`;
    case 'queued':
      return 'queued';
  }
}

/** Runs the example, saying each step through `say`; returns the final scene's facts. */
export async function main(say: (line: string) => void = console.log) {
  const workspace: Workspace = createWorkspace({ id: 'example' });
  const events: string[] = [];
  const unsubscribe = workspace.subscribe((event) => {
    events.push(event.type);
  });

  // Two windows and a surface, all or nothing, as one revision.
  say(
    outcome(
      workspace.transaction([
        { type: 'node.create', node: windowSpec('notes', -1, -3) },
        { type: 'node.create', node: windowSpec('chart', 1, -3) },
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
      ]),
    ),
  );

  // A transaction that fails part-way changes nothing: the first command is not kept either.
  const refused = workspace.transaction([
    { type: 'node.create', node: windowSpec('extra', 0, -5) },
    { type: 'node.create', node: windowSpec('notes', 0, -4) },
  ]);
  say(outcome(refused));

  // Group both windows; each keeps its place in the world.
  say(
    outcome(
      workspace.transaction([
        { type: 'node.group', nodeIds: ['notes', 'chart'], group: { id: 'desk' } },
      ]),
    ),
  );

  // A retried request with the same idempotency key commits once.
  const move = [
    {
      type: 'node.patch' as const,
      id: 'desk',
      transform: {
        position: [0, 0.5, 0] as const,
        rotation: [0, 0, 0, 1] as const,
        scale: [1, 1, 1] as const,
      },
    },
  ];
  const first = workspace.transaction(move, { idempotencyKey: 'raise-desk' });
  const retry = workspace.transaction(move, { idempotencyKey: 'raise-desk' });
  say(
    `${outcome(first)}; retried: ${outcome(retry)}${retry.status === 'committed' && retry.replayed ? ' (replayed)' : ''}`,
  );
  // A world matrix is column-major: its translation is elements 12 to 14.
  const worldY = (): number | undefined => worldMatrix(workspace.getState().nodes, 'notes')?.[13];
  say(`notes is now at y = ${String(worldY())} in the world`);

  say(`undo: ${outcome(workspace.undo())}`);
  say(`redo: ${outcome(workspace.redo())}`);

  const state = workspace.getState();
  const facts = {
    revision: state.revision,
    nodes: [...state.nodes.values()].map((n) => n.id).sort(),
    notesParent: state.nodes.get('notes')?.parentId ?? null,
    refused: refused.status === 'rejected' ? refused.error.code : null,
    replayed: retry.status === 'committed' && retry.replayed,
    worldY: worldY(),
    events: [...new Set(events)].sort(),
  };
  say(`events heard: ${facts.events.join(', ')}`);

  // The listener is the caller's to remove; disposal releases the workspace's own resources.
  unsubscribe();
  await workspace.dispose();
  return facts;
}

if (import.meta.main) await main();
