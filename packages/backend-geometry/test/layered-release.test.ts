import type { SceneState } from '@swf/core';
import type { RendererBackend, RendererSession, ViewGeometry } from '@swf/presentation';
import { viewGeometryOf } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import type { LayeredRendererSession } from '../src/index.js';
import { GeometryRenderer, LayeredRenderer } from '../src/index.js';
import { scene } from './fixture.js';

/** A session that records its release, and fails it when told to. */
function session(log: string[], name: string, failRelease = false): RendererSession {
  return {
    rendererId: `test.${name}/1`,
    viewportId: 'v',
    render: () => {
      throw new Error('not used');
    },
    targetOf: () => null,
    watchLoss: () => () => undefined,
    release() {
      log.push(`${name} released`);
      return failRelease ? Promise.reject(new Error(`${name} release failed`)) : Promise.resolve();
    },
  };
}

/** A native renderer whose every session records its release. */
function nativeRenderer(log: string[], failRelease = false): RendererBackend {
  return {
    id: 'test.native/1',
    apiVersion: 1,
    capabilities: () => ({
      handleKinds: { 'native-dom': 'native' as const },
      transformMode: 'perspective-3d' as const,
      clipping: 'rect' as const,
      hitMapping: false,
      layering: 'dom' as const,
      resourceOwnership: 'renderer' as const,
      recovery: 'rebuild' as const,
    }),
    prepare: () => Promise.resolve(session(log, 'native', failRelease)),
  };
}

function view(): { state: SceneState; view: ViewGeometry } {
  const { ws } = scene([]);
  const state = ws.getState();
  return { state, view: viewGeometryOf(state, 'v') };
}

describe('layered renderer releasing what it made', () => {
  it('releases both sessions when the geometry renderer prepares a session of another kind', async () => {
    const log: string[] = [];
    class Wrong extends GeometryRenderer {
      override prepare(): Promise<RendererSession> {
        return Promise.resolve(session(log, 'geometry'));
      }
    }
    const { state, view: v } = view();
    const layered = new LayeredRenderer({ native: nativeRenderer(log), geometry: new Wrong() });
    await expect(layered.prepare(state, v)).rejects.toThrow(/a session of another kind/);
    expect(log).toEqual(['native released', 'geometry released']);
  });

  it('reports both failures when the geometry renderer fails and the native session cannot be released', async () => {
    const log: string[] = [];
    class Failing extends GeometryRenderer {
      override prepare(): Promise<RendererSession> {
        return Promise.reject(new Error('geometry prepare failed'));
      }
    }
    const { state, view: v } = view();
    const layered = new LayeredRenderer({
      native: nativeRenderer(log, true),
      geometry: new Failing(),
    });
    const error: unknown = await layered.prepare(state, v).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AggregateError);
    const messages = (error as AggregateError).errors.map((e: unknown) => (e as Error).message);
    expect(messages).toEqual(['geometry prepare failed', 'native release failed']);
    expect(log).toEqual(['native released']);
  });

  it('releases the geometry session even when the native release fails, and passes the failure on', async () => {
    const log: string[] = [];
    const { state, view: v } = view();
    const layered = (await new LayeredRenderer({
      native: nativeRenderer(log, true),
      geometry: new GeometryRenderer(),
    }).prepare(state, v)) as LayeredRendererSession;
    await expect(layered.release()).rejects.toThrow('native release failed');
    expect(() => layered.geometry.render({} as never)).toThrow(/was released/);
    // Released once: a second call neither releases again nor fails again.
    await layered.release();
    expect(log).toEqual(['native released']);
  });
});
