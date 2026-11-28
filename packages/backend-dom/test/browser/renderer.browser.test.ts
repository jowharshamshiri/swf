import { SwfFailure } from '@swf/core';
import { createWorkspace } from '@swf/core';
import type { ProjectionProfile, RenderFrame } from '@swf/presentation';
import { conditionFor, createViewOutput, fragmentId, planFrame } from '@swf/presentation';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOM_ATTRIBUTES,
  DOM_COMPOSITOR_CAPABILITIES,
  DOM_RENDERER_CAPABILITIES,
  DomCompositor,
  DomRenderer,
} from '../../src/index.js';

const PERSPECTIVE: ProjectionProfile = {
  id: 'test.perspective/1',
  seamWrapping: false,
  exactInverse: true,
};

const containers: HTMLElement[] = [];
afterEach(() => {
  containers.splice(0).forEach((c) => {
    c.remove();
  });
});

/**
 * A frame of one surface on a card 200×100 at (100, 100) drawn at `scale`, its window placed as
 * `placed` says: live, or unbound when `bound` is false.
 */
function frame(placed: 'exact' | 'approximate' = 'exact', bound = true, scale = 1): RenderFrame {
  const ws = createWorkspace({ id: 'ws' });
  const result = ws.transaction([
    { type: 'node.create', node: { id: 'w', kind: 'window', bounds: [1, 0.5, 0.01] } },
    {
      type: 'surface.attach',
      surface: {
        id: 's',
        ownerNodeId: 'w',
        bindingKey: 'k',
        adapterTypeId: 'test.dom/1',
        bounds: [1, 0.5, 0.01],
      },
    },
  ]);
  if (result.status !== 'committed') {
    throw new Error('no scene');
  }
  const scene = ws.getState();
  const view = {
    viewportId: 'v',
    width: 800,
    height: 400,
    devicePixelRatio: 1,
    camera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const,
    near: 0.05,
    far: null,
    projectionId: PERSPECTIVE.id,
    projectionConfig: null,
  };
  return planFrame({
    scene,
    view,
    output: createViewOutput(scene, 'v', [
      {
        id: fragmentId('v', 's', 0),
        surfaceId: 's',
        viewportId: 'v',
        ordinal: 0,
        bounds: [100, 100, 200, 100],
        card: [100, 100, 200, 100],
        scale,
        representation: 'full',
        depth: 2,
        geometricFidelity: placed,
        nativeOwner: true,
        front: false,
      },
    ]),
    renderer: { id: 'swf.dom-renderer/1', capabilities: DOM_RENDERER_CAPABILITIES },
    compositor: { id: 'swf.dom-compositor/1', capabilities: DOM_COMPOSITOR_CAPABILITIES },
    projection: PERSPECTIVE,
    condition: () =>
      conditionFor(
        bound
          ? {
              attachStrategy: 'native-dom',
              nativeInteraction: 'full',
              uvAddressing: true,
              transformFidelity: 'approximate',
              transparency: false,
              clipping: true,
              cursorMapping: true,
              resize: 'intrinsic',
              viewportSharing: 'single-owner',
              safeDetach: true,
              rebinding: true,
              placeholder: false,
              snapshotHooks: false,
              takeover: true,
            }
          : null,
      ),
    viewportOwns: () => true,
    geometry: (id) => ws.surfaceGeometry(id),
  });
}

async function session(f: RenderFrame) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const renderer = await new DomRenderer({ document }).prepare(f.scene, f.view);
  const compositor = await new DomCompositor().prepare({ viewportId: 'v', container }, renderer);
  return { renderer, compositor, container };
}

describe('the DOM renderer’s declarations', () => {
  it('says why a placeholder stands in, and stops saying it once the content is bound (FR-195)', async () => {
    const unbound = frame('exact', false);
    const { renderer, compositor, container } = await session(unbound);
    compositor.compose(renderer.render(unbound));
    const placeholder = container.querySelector(`[${DOM_ATTRIBUTES.layer}="placeholder"]`);
    expect(placeholder?.getAttribute(DOM_ATTRIBUTES.standIn)).toBe('unbound');
    expect(placeholder?.textContent).toContain('Unbound: no content is bound');
    const bound = frame();
    compositor.compose(renderer.render(bound));
    expect(container.querySelector(`[${DOM_ATTRIBUTES.layer}="placeholder"]`)).toBeNull();
    expect(container.querySelector(`[${DOM_ATTRIBUTES.layer}="content-native"]`)).not.toBeNull();
  });

  it('lays a live element out at its size before the card’s scale, then scales it onto the card', async () => {
    const f = frame('exact', true, 2);
    expect(f.planned[0]?.negotiation).toMatchObject({ mode: 'native', shapeFidelity: 'exact' });
    const { renderer, compositor, container } = await session(f);
    compositor.compose(renderer.render(f));
    const clip = container.querySelector<HTMLElement>(`[${DOM_ATTRIBUTES.layer}="content-native"]`);
    const slot = clip?.querySelector<HTMLElement>(`[${DOM_ATTRIBUTES.slot}]`);
    expect([clip?.style.left, clip?.style.top, clip?.style.width, clip?.style.height]).toEqual([
      '100px',
      '100px',
      '200px',
      '100px',
    ]);
    expect([slot?.style.width, slot?.style.height, slot?.style.transform]).toEqual([
      '100px',
      '50px',
      'scale(2)',
    ]);
    // Scaled, it covers the card's place exactly.
    const box = slot?.getBoundingClientRect();
    const root = clip?.getBoundingClientRect();
    expect([box?.width, box?.height]).toEqual([200, 100]);
    expect([box?.left, box?.top]).toEqual([root?.left, root?.top]);
    expect(clip?.getAttribute(DOM_ATTRIBUTES.anchor)).toBe('exact');
    expect(clip?.getAttribute(DOM_ATTRIBUTES.shape)).toBe('exact');
  });

  it('declares a live element approximated where its card only approximates its window’s place', async () => {
    const f = frame('approximate');
    const { renderer, compositor, container } = await session(f);
    compositor.compose(renderer.render(f));
    const clip = container.querySelector(`[${DOM_ATTRIBUTES.layer}="content-native"]`);
    expect(clip?.getAttribute(DOM_ATTRIBUTES.mode)).toBe('approximated');
    expect(clip?.getAttribute(DOM_ATTRIBUTES.anchor)).toBe('approximate');
    expect(clip?.getAttribute(DOM_ATTRIBUTES.shape)).toBe('approximate');
  });

  it('refuses a frame that would mount one surface’s live element twice', async () => {
    const f = frame();
    const { renderer } = await session(f);
    const [only] = f.planned;
    if (only === undefined) {
      throw new Error('no planned fragment');
    }
    const twice: RenderFrame = {
      ...f,
      planned: [
        only,
        {
          ...only,
          fragment: { ...only.fragment, id: fragmentId('v', 's', 1), ordinal: 1 },
        },
      ],
    };
    let error: unknown;
    try {
      renderer.render(twice);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SwfFailure);
    expect((error as SwfFailure).message).toMatch(/planned as live content twice/);
  });

  it('refuses frames of other viewports and frames after release', async () => {
    const f = frame();
    const { renderer, compositor, container } = await session(f);
    expect(() => renderer.render({ ...f, viewportId: 'other' })).toThrow(SwfFailure);
    await compositor.release();
    await renderer.release();
    await renderer.release();
    expect(container.childElementCount).toBe(0);
    expect(() => renderer.render(f)).toThrow(/released/);
  });

  it('refuses a container that is not an element', async () => {
    const f = frame();
    const renderer = await new DomRenderer({ document }).prepare(f.scene, f.view);
    await expect(
      new DomCompositor().prepare({ viewportId: 'v', container: {} }, renderer),
    ).rejects.toThrow(/must be an element/);
  });
});
