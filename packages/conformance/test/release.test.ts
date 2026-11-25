import type * as Core from '@swf/core';
import type { Workspace } from '@swf/core';
import type {
  Compositor,
  RendererBackend,
  RendererSession,
  RenderedFrame,
} from '@swf/presentation';
import type * as Surfaces from '@swf/surfaces';
import type { SurfaceCapabilities, SurfaceRuntime } from '@swf/surfaces';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterFixture, MockHandle } from '../src/index.js';
import {
  adapterConformance,
  backendConformance,
  handoffConformance,
  mockCapabilities,
  MockCompositor,
  MockOpaqueAdapter,
  MockRenderer,
  runConformance,
} from '../src/index.js';

/** Every workspace and surface runtime the suites make, kept to see that each is disposed. */
const made = vi.hoisted(() => ({
  workspaces: [] as Workspace[],
  runtimes: [] as SurfaceRuntime[],
}));

vi.mock('@swf/core', async (original) => {
  const core = await original<typeof Core>();
  return {
    ...core,
    createWorkspace: (...args: Parameters<typeof core.createWorkspace>) => {
      const workspace = core.createWorkspace(...args);
      made.workspaces.push(workspace);
      return workspace;
    },
  };
});

vi.mock('@swf/surfaces', async (original) => {
  const surfaces = await original<typeof Surfaces>();
  return {
    ...surfaces,
    createSurfaceRuntime: (...args: Parameters<typeof surfaces.createSurfaceRuntime>) => {
      const runtime = surfaces.createSurfaceRuntime(...args);
      made.runtimes.push(runtime);
      return runtime;
    },
  };
});

beforeEach(() => {
  made.workspaces.length = 0;
  made.runtimes.length = 0;
});

/** What the suites made and did not dispose. */
function leftOver(): { workspaces: number; runtimes: number } {
  return {
    workspaces: made.workspaces.filter((w) => w.lifecycle !== 'disposed').length,
    runtimes: made.runtimes.filter((r) => !r.disposed).length,
  };
}

/**
 * The reference renderer, its sessions counted as they are prepared and released, and the output
 * of each render changed as `change` says.
 */
function countedRenderer(
  sessions: { prepared: number; released: number },
  change: (frame: RenderedFrame) => RenderedFrame = (frame) => frame,
): RendererBackend {
  const inner = new MockRenderer();
  return {
    id: inner.id,
    apiVersion: inner.apiVersion,
    capabilities: () => inner.capabilities(),
    async prepare(scene, view) {
      const session = await inner.prepare(scene, view);
      sessions.prepared += 1;
      let released = false;
      const counted: RendererSession = {
        rendererId: session.rendererId,
        viewportId: session.viewportId,
        render: (frame) => change(session.render(frame)),
        targetOf: (surfaceId) => session.targetOf(surfaceId),
        watchLoss: (listener) => session.watchLoss(listener),
        async release() {
          if (!released) {
            released = true;
            sessions.released += 1;
          }
          await session.release();
        },
      };
      return counted;
    },
  };
}

describe('the backend suite releases what it made', () => {
  it('releases every session and disposes every workspace, in cases that pass and that fail', async () => {
    const sessions = { prepared: 0, released: 0 };
    // Every layer but the first is dropped: most cases fail.
    const results = await runConformance(
      backendConformance({
        renderer: () =>
          countedRenderer(sessions, (frame) => ({ ...frame, layers: frame.layers.slice(1) })),
        compositor: () => new MockCompositor(),
      }),
    );
    expect(results.some((r) => r.outcome === 'failed')).toBe(true);
    expect(results.some((r) => r.outcome === 'passed')).toBe(true);
    expect(sessions.prepared).toBeGreaterThan(0);
    expect(sessions.released).toBe(sessions.prepared);
    expect(made.workspaces.length).toBeGreaterThan(0);
    expect(leftOver()).toEqual({ workspaces: 0, runtimes: 0 });
  });

  it('releases the renderer session when the compositor cannot be prepared', async () => {
    const sessions = { prepared: 0, released: 0 };
    const reference = new MockCompositor();
    const failing: Compositor = {
      id: reference.id,
      apiVersion: reference.apiVersion,
      capabilities: () => reference.capabilities(),
      prepare: () => Promise.reject(new Error('the compositor cannot be prepared')),
    };
    const results = await runConformance(
      backendConformance({ renderer: () => countedRenderer(sessions), compositor: () => failing }),
    );
    expect(results.filter((r) => r.outcome === 'failed').length).toBeGreaterThan(0);
    expect(sessions.prepared).toBeGreaterThan(0);
    expect(sessions.released).toBe(sessions.prepared);
    expect(leftOver()).toEqual({ workspaces: 0, runtimes: 0 });
  });
});

describe('the adapter suite releases what it made', () => {
  it('disposes every workspace and runtime, in cases that pass and that fail', async () => {
    const declared: SurfaceCapabilities = mockCapabilities();
    // The unknown key binds: the case for unknown keys fails, the others pass.
    const fixture: AdapterFixture<MockHandle> = {
      create: () => new MockOpaqueAdapter('host.mock/1', declared),
      keys: { valid: ['doc-1', 'doc-2'], unknown: 'ghost' },
      settleMs: 50,
    };
    const results = await runConformance(adapterConformance(fixture));
    expect(results.filter((r) => r.outcome === 'failed').map((r) => r.name)).toEqual([
      expect.stringMatching(/^answers an unknown key with null/),
      expect.stringMatching(/^keeps its binding when a replacement fails/),
    ]);
    expect(made.workspaces.length).toBeGreaterThan(0);
    expect(leftOver()).toEqual({ workspaces: 0, runtimes: 0 });
  });
});

describe('the handoff suite releases what it made', () => {
  it('disposes every workspace and runtime it made', async () => {
    const results = await runConformance(
      handoffConformance({
        renderer: () => new MockRenderer('tested.renderer/1'),
        compositor: () => new MockCompositor('tested.compositor/1'),
      }),
    );
    expect(results.some((r) => r.outcome === 'passed')).toBe(true);
    expect(made.workspaces.length).toBeGreaterThan(0);
    expect(leftOver()).toEqual({ workspaces: 0, runtimes: 0 });
  });
});
