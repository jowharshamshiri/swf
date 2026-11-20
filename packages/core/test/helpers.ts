import type { Transform3D, Vec3 } from '@swf/math';
import { quatFromAxisAngle } from '@swf/math';
import { expect } from 'vitest';
import type {
  NodeSpec,
  SceneCommand,
  TxCommitted,
  TxRejected,
  TxResult,
  Workspace,
  WorkspaceEvent,
  WorkspaceOptions,
} from '../src/index.js';
import { createWorkspace } from '../src/index.js';

/** A workspace with a fixed clock, so timestamps are reproducible. */
export function makeWorkspace(options: Partial<WorkspaceOptions> = {}): Workspace {
  let tick = 1_000;
  return createWorkspace({ id: 'ws', now: () => (tick += 1), ...options });
}

export function committed(result: TxResult): TxCommitted {
  if (result.status !== 'committed') {
    throw new Error(`expected a commit, got ${JSON.stringify(result)}`);
  }
  return result;
}

export function rejected(result: TxResult): TxRejected {
  if (result.status !== 'rejected') {
    throw new Error(`expected a rejection, got ${JSON.stringify(result)}`);
  }
  return result;
}

export function at(position: Vec3, angle = 0, scale: Vec3 = [1, 1, 1]): Transform3D {
  return { position, rotation: quatFromAxisAngle([0, 1, 0], angle), scale };
}

export function window(id: string, extra: Partial<NodeSpec> = {}): SceneCommand {
  return { type: 'node.create', node: { id, kind: 'window', bounds: [1.6, 0.9, 0.01], ...extra } };
}

/** Records every event the workspace delivers. */
export function record(ws: Workspace): WorkspaceEvent[] {
  const events: WorkspaceEvent[] = [];
  ws.subscribe((event) => events.push(event));
  return events;
}

export function expectClose(
  actual: readonly number[],
  expected: readonly number[],
  epsilon = 1e-9,
) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, i) => {
    expect(Math.abs(value - (expected[i] ?? NaN))).toBeLessThanOrEqual(epsilon);
  });
}
