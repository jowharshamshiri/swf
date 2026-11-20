import type { SceneCommand, SurfaceSpec, Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import type { RuntimeEvent, SurfaceRuntime } from '../src/index.js';

export function makeWorkspace(): Workspace {
  let tick = 1_000;
  return createWorkspace({ id: 'ws', now: () => (tick += 1) });
}

export function window(id: string): SceneCommand {
  return { type: 'node.create', node: { id, kind: 'window', bounds: [1.6, 0.9, 0.01] } };
}

export function surface(
  id: string,
  ownerNodeId: string,
  bindingKey: string | null,
  extra: Partial<SurfaceSpec> = {},
): SceneCommand {
  return {
    type: 'surface.attach',
    surface: {
      id,
      ownerNodeId,
      bindingKey,
      adapterTypeId: 'host.view/1',
      bounds: [1.6, 0.9, 0.01],
      ...extra,
    },
  };
}

/** Lets pending promise continuations (and the runtime's microtasks) run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

export function record(runtime: SurfaceRuntime): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  return events;
}

/** The state transitions of one surface, as `from>to` strings. */
export function transitions(events: readonly RuntimeEvent[], surfaceId: string): string[] {
  return events.flatMap((event) =>
    event.type === 'presentation.stateChanged' && event.payload.surfaceId === surfaceId
      ? [`${event.payload.from ?? 'none'}>${event.payload.to}`]
      : [],
  );
}

export function committed(result: ReturnType<Workspace['dispatch']>): void {
  if (result.status !== 'committed') {
    throw new Error(`expected a commit, got ${JSON.stringify(result)}`);
  }
}
