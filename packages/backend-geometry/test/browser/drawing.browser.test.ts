import { DomRenderer } from '@swf/backend-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LayeredRendererSession, LayerCompositorSession } from '../../src/index.js';
import {
  GeometryRenderer,
  LAYER_COMPOSITOR_CAPABILITIES,
  LAYER_COMPOSITOR_ID,
  LayerCompositor,
  LayeredRenderer,
} from '../../src/index.js';
import type { Placed } from '../fixture.js';
import { H, plan, scene, W } from '../fixture.js';

const containers: HTMLElement[] = [];
afterEach(() => {
  containers.splice(0).forEach((c) => {
    c.remove();
  });
});

const QUADRANTS = {
  tl: [220, 30, 30],
  tr: [30, 200, 30],
  br: [30, 30, 220],
  bl: [230, 200, 20],
} as const;

/** A 64×32 drawable in four coloured quadrants, so orientation and placement can be read back. */
function quadrants(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('no 2D context');
  }
  const fill = ([r, g, b]: readonly [number, number, number], x: number, y: number) => {
    ctx.fillStyle = `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
    ctx.fillRect(x, y, 32, 16);
  };
  fill(QUADRANTS.tl, 0, 0);
  fill(QUADRANTS.tr, 32, 0);
  fill(QUADRANTS.br, 32, 16);
  fill(QUADRANTS.bl, 0, 16);
  return canvas;
}

function container(): HTMLElement {
  const c = document.createElement('div');
  document.body.append(c);
  containers.push(c);
  return c;
}

/** The colour at a viewport point, as the browser composited the drawn layers there. */
function pixelAt(root: HTMLElement, x: number, y: number): [number, number, number, number] {
  for (const canvas of [...root.querySelectorAll('canvas')].reverse()) {
    const ctx = canvas.getContext('2d');
    // Reading pixels back is for this test only; the backend never does.
    const data = ctx?.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    if (data !== undefined && (data[3] ?? 0) > 0) {
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
    }
  }
  return [0, 0, 0, 0];
}

/** Whether a colour matches, within a tolerance per channel; the message shows what was found. */
function near(actual: readonly number[], expected: readonly number[], tolerance = 8): boolean {
  const ok = expected.every((v, i) => Math.abs((actual[i] ?? NaN) - v) <= tolerance);
  if (!ok) {
    console.warn(`found rgba(${actual.join(', ')}), expected rgba(${expected.join(', ')})`);
  }
  return ok;
}

async function drawn(placed: readonly Placed[], revision: () => number | undefined = () => 1) {
  const { ws, projections, kinds } = scene(placed);
  const source = quadrants();
  const renderer = new GeometryRenderer({
    drawables: () => {
      const r = revision();
      return r === undefined
        ? { source, width: 64, height: 32 }
        : { source, width: 64, height: 32, revision: r };
    },
    projections,
  });
  const frame = plan(
    ws,
    projections,
    kinds,
    { id: renderer.id, capabilities: renderer.capabilities() },
    { id: LAYER_COMPOSITOR_ID, capabilities: LAYER_COMPOSITOR_CAPABILITIES },
  );
  const session = await renderer.prepare(frame.scene, frame.view);
  const compositor = (await new LayerCompositor().prepare(
    { viewportId: 'v', container: container() },
    session,
  )) as LayerCompositorSession;
  const composed = compositor.compose(session.render(frame));
  /**
   * Where a point of a window, in its own units from its centre (x right, y up), lies on its card
   * as drawn: on whichever copy of the card shows it, across the seam.
   */
  const screen = (nodeId: string, [lx, ly]: readonly [number, number]): [number, number] => {
    const node = ws.getState().nodes.get(nodeId);
    if (node === undefined) {
      throw new Error('no node');
    }
    const points = frame.planned
      .filter((p) => ws.getState().surfaces.get(p.fragment.surfaceId)?.ownerNodeId === nodeId)
      .map(({ fragment: { card } }): [number, number] => [
        card[0] + card[2] / 2 + (lx * card[2]) / node.bounds[0],
        card[1] + card[3] / 2 - (ly * card[3]) / node.bounds[1],
      ]);
    const shown = points.find(([x]) => x >= 0 && x < W) ?? points[0];
    if (shown === undefined) {
      throw new Error('not in view');
    }
    return shown;
  };
  return { ws, frame, session, compositor, composed, screen };
}

describe('drawn content (ARCH-011)', () => {
  it('lands each part of a drawable where that part of its surface lies on the card', async () => {
    const { compositor, screen, composed } = await drawn([
      { id: 'a', kind: 'drawn', heading: 0.4, distance: 3, y: 0.3 },
    ]);
    expect(composed.occlusion).toBe('layer-order');
    for (const [name, local] of [
      ['tl', [-0.5, 0.3]],
      ['tr', [0.5, 0.3]],
      ['br', [0.5, -0.3]],
      ['bl', [-0.5, -0.3]],
    ] as const) {
      const [x, y] = screen('a', local);
      expect(near(pixelAt(compositor.root, x, y), [...QUADRANTS[name], 255]), name).toBe(true);
    }
    // Outside the surface nothing is drawn.
    const [x, y] = screen('a', [1.5, 0]);
    expect(pixelAt(compositor.root, x, y)[3]).toBe(0);
  });

  it('draws a wide surface flat on its card, its edges straight however wide it is', async () => {
    const { compositor, screen } = await drawn([
      { id: 'wide', kind: 'drawn', heading: 0, distance: 3, size: [8, 2] },
    ]);
    // A panorama never bends a card: just inside its top edge there is content all along, and just
    // above it none, at its middle as at its ends.
    for (const x of [-3.8, 0, 3.8]) {
      const [ix, iy] = screen('wide', [x, 0.97]);
      const [ox, oy] = screen('wide', [x, 1.03]);
      expect(iy).toBeCloseTo(screen('wide', [0, 0.97])[1], 9);
      expect(pixelAt(compositor.root, ix, iy)[3]).toBe(255);
      expect(pixelAt(compositor.root, ox, oy)[3]).toBe(0);
    }
  });

  it('draws a surface split by the seam on both sides, each side its own half', async () => {
    const { compositor, frame, screen } = await drawn([
      { id: 's', kind: 'drawn', heading: Math.PI, distance: 3 },
    ]);
    expect(frame.planned.filter((p) => p.negotiation.layer === 'content-raster')).toHaveLength(2);
    // Its card straddles the seam: its left half at the right edge of the image, its right half at
    // the left.
    const [lx, ly] = screen('s', [-0.5, 0.3]);
    const [rx, ry] = screen('s', [0.5, 0.3]);
    expect(lx).toBeGreaterThan(W / 2);
    expect(rx).toBeLessThan(W / 2);
    expect(near(pixelAt(compositor.root, lx, ly), [...QUADRANTS.tl, 255])).toBe(true);
    expect(near(pixelAt(compositor.root, rx, ry), [...QUADRANTS.tr, 255])).toBe(true);
    // Right at the seam each side still shows its own side of the surface, unstretched.
    const [ex, ey] = screen('s', [-0.04, 0.3]);
    const [fx, fy] = screen('s', [0.04, 0.3]);
    expect(ex).toBeGreaterThan(W - 6);
    expect(fx).toBeLessThan(6);
    expect(near(pixelAt(compositor.root, ex, ey), [...QUADRANTS.tl, 255])).toBe(true);
    expect(near(pixelAt(compositor.root, fx, fy), [...QUADRANTS.tr, 255])).toBe(true);
  });

  it('redraws a drawable only when its revision changes, and one without a revision every frame (NFR-005)', async () => {
    let revision: number | undefined = 1;
    const s = await drawn([{ id: 'a', kind: 'drawn', heading: 0.4, distance: 3 }], () => revision);
    const canvas = s.compositor.root.querySelector('canvas');
    const again = () => s.compositor.compose(s.session.render(s.frame));
    // Each repaint of a canvas starts by clearing it.
    const painted = vi.spyOn(CanvasRenderingContext2D.prototype, 'clearRect');
    try {
      // Unchanged: no layer is redrawn and the canvas is left alone.
      const rendered = s.session.render(s.frame);
      expect(rendered.writes).toBe(0);
      expect(s.compositor.compose(rendered).writes).toBe(0);
      expect(painted).not.toHaveBeenCalled();
      // A new revision redraws its layer, and only that canvas is painted again.
      revision = 2;
      const changed = s.session.render(s.frame);
      expect(changed.writes).toBe(1);
      expect(s.compositor.compose(changed).writes).toBe(1);
      expect(painted).toHaveBeenCalledTimes(1);
      // Without a revision the content may change at any time (live media), so every frame redraws.
      revision = undefined;
      again();
      painted.mockClear();
      expect(again().writes).toBe(1);
      expect(painted).toHaveBeenCalledTimes(1);
    } finally {
      painted.mockRestore();
    }
    expect(s.compositor.root.querySelector('canvas')).toBe(canvas);
  });

  it('draws proxies, placeholders, chrome and out-of-view indicators', async () => {
    const { compositor, frame, screen } = await drawn([
      { id: 'p', kind: 'proxied', heading: -0.5, distance: 3, label: 'Proxy' },
      { id: 'u', kind: 'unbound', heading: 0.5, distance: 3, label: 'Unbound' },
    ]);
    const layers = frame.planned.map((p) => p.negotiation.layer);
    expect(layers).toEqual(expect.arrayContaining(['proxy', 'placeholder']));
    for (const node of ['p', 'u']) {
      const [x, y] = screen(node, [0, 0]);
      expect(pixelAt(compositor.root, x, y)[3]).toBeGreaterThan(0);
    }
    // No pixels of the frame are left uncomposited off to the side.
    expect(pixelAt(compositor.root, W / 2, 5)[3]).toBe(0);
    expect(H).toBe(400);
  });
});

describe('live and drawn layers together (D3, FR-088, ARCH-013)', () => {
  async function layered(placed: readonly Placed[]) {
    const { ws, projections, kinds } = scene(placed);
    const source = quadrants();
    const renderer = new LayeredRenderer({
      native: new DomRenderer({ document }),
      geometry: new GeometryRenderer({
        drawables: () => ({ source, width: 64, height: 32 }),
        projections,
      }),
    });
    const caps = { id: renderer.id, capabilities: renderer.capabilities() };
    const compositorCaps = { id: LAYER_COMPOSITOR_ID, capabilities: LAYER_COMPOSITOR_CAPABILITIES };
    const frameOf = (reverse = false) =>
      plan(ws, projections, kinds, caps, compositorCaps, reverse);
    const frame = frameOf();
    const session = (await renderer.prepare(frame.scene, frame.view)) as LayeredRendererSession;
    const compositor = (await new LayerCompositor().prepare(
      { viewportId: 'v', container: container() },
      session,
    )) as LayerCompositorSession;
    return { ws, projections, kinds, frameOf, session, compositor };
  }

  const zOf = (element: Element | null | undefined) =>
    Number((element as HTMLElement | null | undefined)?.style.zIndex ?? NaN);

  it('stacks a live element between drawn layers exactly as planned, splitting canvases around it', async () => {
    const s = await layered([
      { id: 'far', kind: 'drawn', heading: 0, distance: 6, size: [4, 2.4] },
      { id: 'live', kind: 'live', heading: 0, distance: 4 },
      { id: 'near', kind: 'drawn', heading: 0.1, distance: 2, size: [1, 0.6] },
    ]);
    const rendered = s.session.render(s.frameOf());
    const composed = s.compositor.compose(rendered);
    expect(composed.occlusion).toBe('layer-order');
    // Each window's chrome stacks right after its own content, live or drawn.
    const order = composed.order;
    for (const node of ['far', 'live', 'near']) {
      const at = order.indexOf(`chrome:${node}`);
      expect(order[at - 1]).toContain(`/${node}-s/`);
    }
    // From here on, nothing the compositor does moves the live element in the document.
    const moves: MutationRecord[] = [];
    const watch = new MutationObserver((records) => moves.push(...records));
    watch.observe(s.compositor.root, { childList: true });
    const canvases = [...s.compositor.root.querySelectorAll('canvas')];
    const slot = s.compositor.root.querySelector('[data-swf-surface="live-s"]');
    // Far drawn content, then the live element, then nearer drawn content: two canvases.
    expect(canvases).toHaveLength(2);
    const [below, above] = canvases.sort((a, b) => zOf(a) - zOf(b));
    expect(zOf(below)).toBeLessThan(zOf(slot));
    expect(zOf(slot)).toBeLessThan(zOf(above));
    // Depth order changes: the live window goes behind everything; one canvas above it.
    expect(
      s.ws.dispatch({
        type: 'node.patch',
        id: 'live',
        transform: { position: [0, 0, -8], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      }).status,
    ).toBe('committed');
    s.compositor.compose(s.session.render(s.frameOf()));
    const after = [...s.compositor.root.querySelectorAll('canvas')];
    expect(after).toHaveLength(1);
    expect(zOf(after[0])).toBeGreaterThan(zOf(slot));
    // The live element stayed where it was in the document.
    expect(s.compositor.root.querySelector('[data-swf-surface="live-s"]')).toBe(slot);
    const moved = watch.takeRecords().concat(moves);
    watch.disconnect();
    expect(moved.some((r) => [...r.addedNodes, ...r.removedNodes].includes(slot as Node))).toBe(
      false,
    );
  });

  it('composes the same frame the same way however its fragments were supplied', async () => {
    const s = await layered([
      { id: 'a', kind: 'drawn', heading: -0.3, distance: 3 },
      { id: 'b', kind: 'live', heading: 0, distance: 4 },
      { id: 'c', kind: 'proxied', heading: 0.3, distance: 3.5 },
      { id: 'd', kind: 'drawn', heading: 0.1, distance: 5 },
    ]);
    const forward = s.frameOf();
    const reversed = s.frameOf(true);
    expect(reversed.output.fragments.map((f) => f.id)).toEqual(
      forward.output.fragments.map((f) => f.id),
    );
    const snapshot = () => {
      const canvases = [...s.compositor.root.querySelectorAll('canvas')];
      return {
        z: [...s.compositor.root.children].map(
          (e) => `${e.tagName}@${(e as HTMLElement).style.zIndex}`,
        ),
        pixels: canvases.map((c) =>
          Array.from(c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data ?? []).join(
            ',',
          ),
        ),
      };
    };
    const one = s.compositor.compose(s.session.render(forward));
    const first = snapshot();
    const two = s.compositor.compose(s.session.render(reversed));
    const second = snapshot();
    expect(two.order).toEqual(one.order);
    expect(second.z).toEqual(first.z);
    expect(second.pixels).toEqual(first.pixels);
  });
});
