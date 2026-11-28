import { SwfFailure } from '@swf/core';
import type { CompositionLayer, RenderedFrame, RepresentationPolicy } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import type { GeometryInks } from '../src/index.js';
import {
  DEFAULT_GEOMETRY_INKS,
  drawableIssue,
  GeometryRenderer,
  isGeometryLayer,
  LAYER_COMPOSITOR_CAPABILITIES,
  LAYER_COMPOSITOR_ID,
  LayeredRenderer,
} from '../src/index.js';
import { plan, scene } from './fixture.js';

/** How wide a text is written here, where no canvas measures it: seven pixels a letter. */
const measureText = (text: string) => 7 * text.length;

/** A drawable stand-in: the renderer only records it into its drawing commands. */
const drawable = { source: {} as CanvasImageSource, width: 64, height: 32 };

async function render(
  placed: Parameters<typeof scene>[0],
  options: ConstructorParameters<typeof GeometryRenderer>[0] = {},
  horizontal = 360,
  withProjections = true,
  representation?: RepresentationPolicy,
): Promise<{ frame: ReturnType<typeof plan>; rendered: RenderedFrame }> {
  const { ws, projections, kinds } = scene(placed, horizontal);
  const renderer = new GeometryRenderer({
    drawables: () => drawable,
    ...(withProjections ? { projections } : {}),
    measureText,
    ...options,
  });
  const frame = plan(
    ws,
    projections,
    kinds,
    { id: renderer.id, capabilities: renderer.capabilities() },
    { id: LAYER_COMPOSITOR_ID, capabilities: LAYER_COMPOSITOR_CAPABILITIES },
    false,
    representation,
  );
  const session = await renderer.prepare(frame.scene, frame.view);
  return { frame, rendered: session.render(frame) };
}

describe('geometry renderer', () => {
  it('draws every kind of surface it is planned for, and shows live ones as proxies', async () => {
    const { frame, rendered } = await render([
      { id: 'live', kind: 'live', heading: -0.8, distance: 3 },
      { id: 'drawn', kind: 'drawn', heading: 0, distance: 3 },
      { id: 'prox', kind: 'proxied', heading: 0.8, distance: 3 },
      { id: 'none', kind: 'unbound', heading: 1.6, distance: 3 },
    ]);
    const categories = Object.fromEntries(
      rendered.layers
        .filter((l) => l.surfaceId !== null)
        .map((l) => [l.surfaceId ?? '', l.category] as const),
    );
    expect(categories).toEqual({
      'live-s': 'proxy',
      'drawn-s': 'content-raster',
      'prox-s': 'proxy',
      'none-s': 'placeholder',
    });
    expect(rendered.layers.every((l) => isGeometryLayer(l.content))).toBe(true);
    expect(rendered.size).toEqual({ width: 800, height: 400, devicePixelRatio: 1 });
    // A live surface became a proxy because this renderer cannot present it, and says so.
    const live = frame.planned.find((p) => p.fragment.surfaceId === 'live-s');
    expect(live?.negotiation.fallback?.gaps.some((g) => g.requirement === 'renderer')).toBe(true);
  });

  it('writes why a placeholder stands in, in the host’s words when it gives them (FR-195)', async () => {
    const placed = [
      { id: 'drawn', kind: 'drawn', heading: 0, distance: 3, label: 'Drawn' },
      { id: 'none', kind: 'unbound', heading: 0.8, distance: 3, label: 'None' },
    ] as const;
    const of = (rendered: RenderedFrame, surfaceId: string) =>
      rendered.layers.find((l) => l.surfaceId === surfaceId);
    const english = await render(placed);
    expect(drawn(of(english.rendered, 'none-s'))).toEqual([
      'fill',
      'stroke',
      'fillText:Unbound: no content is bound',
    ]);
    // Drawn content is itself: nothing is said over it.
    expect(drawn(of(english.rendered, 'drawn-s'))).not.toContain(
      'fillText:Unbound: no content is bound',
    );
    const host = await render(placed, { standIn: (reason) => `[${reason}]` });
    expect(drawn(of(host.rendered, 'none-s'))).toContain('fillText:[unbound]');
  });

  it('draws drawn content exactly on its card, whatever the projection (AC-005, ARCH-012)', async () => {
    const { frame, rendered } = await render([
      { id: 'drawn', kind: 'drawn', heading: 0, distance: 3 },
    ]);
    const planned = frame.planned.find((p) => p.fragment.surfaceId === 'drawn-s');
    expect(planned?.negotiation).toMatchObject({
      mode: 'exact',
      shapeFidelity: 'exact',
      contentFidelity: 'exact',
      layer: 'content-raster',
      fallback: null,
    });
    // The drawable is drawn whole into the surface's place on the card.
    const images = drawnImages(rendered.layers.find((l) => l.surfaceId === 'drawn-s'));
    expect(images).toEqual([[...(planned?.fragment.bounds ?? [])]]);
  });

  it('stacks each window’s chrome after its last fragment, then the title bars, and indicators on top', async () => {
    const { frame, rendered } = await render(
      [
        { id: 'a', kind: 'drawn', heading: 0, distance: 3, label: 'A' },
        { id: 'b', kind: 'proxied', heading: 0.6, distance: 4, label: 'B' },
        { id: 'away', kind: 'drawn', heading: Math.PI, distance: 3, label: 'Away' },
      ],
      {},
      120,
    );
    const ids = rendered.layers.map((l) => l.id);
    const fragmentIds = frame.planned.map((p) => p.fragment.id);
    // The fragments keep the plan's order; each chrome layer follows its window's fragment.
    expect(ids.filter((id) => !id.startsWith('chrome:') && !id.startsWith('overlay:'))).toEqual(
      frame.planned.map((p) => `${p.negotiation.layer}:${p.fragment.id}`),
    );
    for (const node of ['a', 'b']) {
      const at = ids.indexOf(`chrome:${node}`);
      const fragment = fragmentIds.find((f) => f.includes(`/${node}-s/`));
      expect(ids[at - 1]).toContain(fragment);
      const content = rendered.layers[at]?.content;
      expect(isGeometryLayer(content) && content.after).toBe(fragment);
    }
    // The windows' title bars over every window, each named on its own (no window here is shown by
    // its label alone, so no name is written elsewhere); the window behind the camera is out of a
    // 120° view: an indicator points the way.
    expect(ids.slice(-2)).toEqual(['overlay:bars', 'overlay:indicators']);
    expect(ids).not.toContain('overlay:names');
    const bars = drawn(rendered.layers.find((l) => l.id === 'overlay:bars'));
    // B stands farther: its bar is drawn first, and A's over it.
    expect(bars.filter((call) => call.startsWith('fillText:'))).toEqual([
      'fillText:B',
      'fillText:A',
    ]);
    expect(frame.planned.some((p) => p.fragment.surfaceId === 'away-s')).toBe(false);
  });

  it('draws each window’s title bar in the host’s colours for it, at every place its card is drawn', async () => {
    const { frame, rendered } = await render(
      [
        // Straddling the seam behind the camera: its card drawn at both edges.
        { id: 'seam', kind: 'drawn', heading: Math.PI - 0.02, distance: 3, label: 'Seam' },
        { id: 'plain', kind: 'drawn', heading: 0, distance: 3, label: 'Plain' },
      ],
      {
        titleBars: (nodeId) =>
          nodeId === 'seam' ? { fill: 'rgb(10, 20, 30)', text: 'rgb(40, 50, 60)' } : null,
      },
    );
    expect(frame.planned.filter((p) => p.fragment.surfaceId === 'seam-s')).toHaveLength(2);
    const bars = inked(rendered.layers.find((l) => l.id === 'overlay:bars'));
    expect(bars.filter((call) => call === 'fillText:Seam rgb(40, 50, 60)')).toHaveLength(2);
    expect(bars).toContain('fill rgb(10, 20, 30)');
    // A window the host gives no colours is drawn in the inks.
    expect(bars).toContain(`fillText:Plain ${DEFAULT_GEOMETRY_INKS.text}`);
  });

  it('draws a compact window as its proxy, and a label-only one as a mark named beside it, without chrome (FR-122)', async () => {
    const chosen: Record<string, 'compact' | 'label'> = { near: 'compact', far: 'label' };
    const { rendered } = await render(
      [
        { id: 'near', kind: 'drawn', heading: 0, distance: 4, label: 'Near' },
        { id: 'far', kind: 'drawn', heading: 0.8, distance: 7, label: 'Far' },
      ],
      {},
      360,
      true,
      { id: 'test.depth/1', representationOf: ({ nodeId }) => chosen[nodeId] ?? 'full' },
    );
    const of = (surfaceId: string) => rendered.layers.find((l) => l.surfaceId === surfaceId);
    // Drawable content that could be drawn exactly is represented instead.
    expect(of('near-s')?.category).toBe('proxy');
    expect(of('far-s')?.category).toBe('proxy');
    expect(drawn(of('near-s'))).toEqual(['fill', 'stroke']);
    // The label alone: a mark, no box, its name with the others.
    expect(drawn(of('far-s'))).toEqual(['fill']);
    const ids = rendered.layers.map((l) => l.id);
    expect(ids).toContain('chrome:near');
    expect(ids).not.toContain('chrome:far');
    // The compact window named on its title bar, the label alone beside its mark.
    const bars = drawn(rendered.layers.find((l) => l.id === 'overlay:bars'));
    expect(bars).toEqual(['fillText:Near']);
    const names = drawn(rendered.layers.find((l) => l.id === 'overlay:names'));
    expect(names).toEqual(['fillText:Far']);
  });

  it('draws chrome, labels and indicators in the host’s inks, read every frame (WCAG 1.4.3, 1.4.11, 2.4.7)', async () => {
    const { ws, projections, kinds } = scene(
      [
        { id: 'a', kind: 'drawn', heading: 0, distance: 3, label: 'A' },
        { id: 'b', kind: 'drawn', heading: 0.6, distance: 3, label: 'B' },
        { id: 'c', kind: 'drawn', heading: -0.6, distance: 3, label: 'C' },
        { id: 'away', kind: 'drawn', heading: Math.PI, distance: 3, label: 'Away' },
      ],
      120,
    );
    ws.transaction([
      { type: 'selection.set', ids: ['a'] },
      { type: 'focus.set', id: 'b' },
    ]);
    let inks: GeometryInks = {
      frame: 'rgb(1, 1, 1)',
      selected: 'rgb(2, 2, 2)',
      focused: 'rgb(3, 3, 3)',
      text: 'rgb(4, 4, 4)',
      ground: 'rgb(5, 5, 5)',
    };
    const renderer = new GeometryRenderer({
      drawables: () => drawable,
      projections,
      inks: () => inks,
      measureText,
    });
    const draw = async () => {
      const frame = plan(
        ws,
        projections,
        kinds,
        { id: renderer.id, capabilities: renderer.capabilities() },
        { id: LAYER_COMPOSITOR_ID, capabilities: LAYER_COMPOSITOR_CAPABILITIES },
      );
      const session = await renderer.prepare(frame.scene, frame.view);
      const rendered = session.render(frame);
      return (id: string) => inked(rendered.layers.find((l) => l.id === id));
    };
    let layer = await draw();
    // The selected window's frame and its handles, the focused one's frame, any other's frame.
    expect(layer('chrome:a')).toEqual(['stroke rgb(2, 2, 2)', 'fill rgb(2, 2, 2)']);
    expect(layer('chrome:b')).toEqual(['stroke rgb(3, 3, 3)']);
    expect(layer('chrome:c')).toEqual(['stroke rgb(1, 1, 1)']);
    // Each title bar in the ground ink with its name in the text ink, the selected one's edged in
    // its ink and the focused one's in its (the host gives no colours of its own here).
    const bars = layer('overlay:bars');
    const barOf = (name: string) => {
      const at = bars.indexOf(`fillText:${name} rgb(4, 4, 4)`);
      return bars.slice(bars.lastIndexOf('fill rgb(5, 5, 5)', at), at + 1);
    };
    expect(barOf('A')).toEqual([
      'fill rgb(5, 5, 5)',
      'stroke rgb(2, 2, 2)',
      'fillText:A rgb(4, 4, 4)',
    ]);
    expect(barOf('B')).toEqual([
      'fill rgb(5, 5, 5)',
      'stroke rgb(3, 3, 3)',
      'fillText:B rgb(4, 4, 4)',
    ]);
    expect(barOf('C')).toEqual(['fill rgb(5, 5, 5)', 'fillText:C rgb(4, 4, 4)']);
    // Each mark at the edge ringed in the ground ink, so it reads over a window there too, then
    // its window's name on its ground.
    expect(layer('overlay:indicators')).toEqual([
      'stroke rgb(5, 5, 5)',
      'fill rgb(1, 1, 1)',
      'fill rgb(5, 5, 5)',
      'fillText:Away rgb(4, 4, 4)',
    ]);
    // A change of the host's inks (a switch to a dark appearance) is drawn at the next frame.
    inks = { ...inks, frame: 'rgb(9, 9, 9)', text: 'rgb(8, 8, 8)', ground: 'rgb(7, 7, 7)' };
    layer = await draw();
    expect(layer('chrome:c')).toEqual(['stroke rgb(9, 9, 9)']);
    expect(layer('overlay:bars')).toContain('fillText:C rgb(8, 8, 8)');
    expect(layer('overlay:bars')).toContain('fill rgb(7, 7, 7)');
    expect(layer('overlay:indicators').slice(0, 2)).toEqual([
      'stroke rgb(7, 7, 7)',
      'fill rgb(9, 9, 9)',
    ]);
    expect(DEFAULT_GEOMETRY_INKS).toEqual({
      frame: 'rgb(118, 118, 118)',
      selected: 'rgb(0, 95, 184)',
      focused: 'rgb(168, 74, 0)',
      text: 'rgb(30, 30, 30)',
      ground: 'rgb(255, 255, 255)',
    });
  });

  it('draws a stand-in’s words on a ground of its own, whatever the view is drawn over', async () => {
    const { rendered } = await render([
      { id: 'prox', kind: 'proxied', heading: 0, distance: 3, label: 'P' },
      { id: 'none', kind: 'unbound', heading: 0.8, distance: 3, label: 'N' },
    ]);
    const of = (surfaceId: string) => inked(rendered.layers.find((l) => l.surfaceId === surfaceId));
    // Opaque grounds, each with an ink 4.5:1 or more on it.
    expect(of('prox-s')).toEqual(['fill rgb(72, 84, 108)', 'stroke rgb(48, 56, 72)']);
    expect(of('none-s')).toEqual([
      'fill rgb(220, 220, 220)',
      'stroke rgb(90, 90, 90)',
      'fillText:Unbound: no content is bound rgb(40, 40, 40)',
    ]);
  });

  it('draws chrome from the cards alone, and indicators only with projection modules', async () => {
    const placed = [
      { id: 'a', kind: 'drawn', heading: 0, distance: 3, label: 'A' },
      { id: 'away', kind: 'drawn', heading: Math.PI, distance: 3, label: 'Away' },
    ] as const;
    const without = await render(placed, {}, 120, false);
    expect(without.rendered.layers.map((l) => l.id)).not.toContain('overlay:indicators');
    expect(without.rendered.layers.map((l) => l.category)).toEqual([
      'content-raster',
      'chrome',
      'overlay',
    ]);
    const withModules = await render(placed, {}, 120, true);
    expect(withModules.rendered.layers.map((l) => l.id)).toContain('overlay:indicators');
    expect(new GeometryRenderer().capabilities().transformMode).toBe('affine-2d');
  });

  it('refuses what it cannot draw, saying which surface', async () => {
    await expect(
      render([{ id: 'a', kind: 'drawn', heading: 0, distance: 3 }], { drawables: () => undefined }),
    ).rejects.toThrow(/drawable of surface "a-s": there is none/);
    await expect(
      render([{ id: 'a', kind: 'drawn', heading: 0, distance: 3 }], {
        drawables: () => ({ source: {}, width: 0, height: 4 }),
      }),
    ).rejects.toThrow(/width must be a positive finite number/);
    const { ws, projections, kinds } = scene([{ id: 'a', kind: 'live', heading: 0, distance: 3 }]);
    const renderer = new GeometryRenderer({ projections });
    // A frame planned for a renderer that presents live content.
    const frame = plan(
      ws,
      projections,
      kinds,
      {
        id: 'native/1',
        capabilities: { ...renderer.capabilities(), handleKinds: { 'native-dom': 'native' } },
      },
      { id: LAYER_COMPOSITOR_ID, capabilities: LAYER_COMPOSITOR_CAPABILITIES },
    );
    const session = await renderer.prepare(frame.scene, frame.view);
    expect(() => session.render(frame)).toThrow(SwfFailure);
    expect(() => session.render(frame)).toThrow(/cannot present live content/);
    await session.release();
    expect(() => session.render(frame)).toThrow(/released/);
  });
});

describe('layered renderer', () => {
  it('claims only what both renderers can do together', () => {
    const native = {
      id: 'test.native/1',
      apiVersion: 1,
      capabilities: () => ({
        handleKinds: { 'native-dom': 'native' as const, 'proxy-only': 'proxy' as const },
        transformMode: 'perspective-3d' as const,
        clipping: 'rect' as const,
        hitMapping: false,
        layering: 'dom' as const,
        resourceOwnership: 'renderer' as const,
        recovery: 'rebuild' as const,
      }),
      prepare: () => Promise.reject(new Error('not used')),
    };
    const caps = new LayeredRenderer({
      native,
      geometry: new GeometryRenderer({ projections: scene([]).projections }),
    }).capabilities();
    expect(caps).toEqual({
      handleKinds: { drawable: 'exact', 'proxy-only': 'proxy', 'native-dom': 'native' },
      transformMode: 'affine-2d',
      clipping: 'rect',
      hitMapping: false,
      layering: 'dom-and-raster',
      resourceOwnership: 'renderer',
      recovery: 'rebuild',
    });
    expect(() =>
      new LayeredRenderer({
        native: { ...native, capabilities: () => ({ ...native.capabilities(), handleKinds: {} }) },
        geometry: new GeometryRenderer(),
      }).capabilities(),
    ).toThrow(/presents no live content/);
    expect(
      () => new LayeredRenderer({ id: 'layered', native, geometry: new GeometryRenderer() }),
    ).toThrow(RangeError);
  });
});

describe('drawables', () => {
  it('accepts only sized image sources as drawables', () => {
    expect(drawableIssue(drawable)).toBeNull();
    expect(drawableIssue(null)).toMatch(/object/);
    expect(drawableIssue({ width: 1, height: 1 })).toMatch(/image source/);
    expect(drawableIssue({ source: {}, width: Infinity, height: 1 })).toMatch(/width/);
  });
});

/** The drawing calls a layer makes (fills, strokes and the text it writes), in order. */
/** What a layer draws, each fill, stroke and text with the colour it is drawn in. */
function inked(layer: CompositionLayer | undefined): string[] {
  const content = layer?.content;
  if (!isGeometryLayer(content)) {
    throw new Error('not a drawn layer');
  }
  const calls: string[] = [];
  const style = { fillStyle: '', strokeStyle: '' };
  const ctx = new Proxy(style, {
    get(target, name) {
      if (name === 'fill') {
        return () => calls.push(`fill ${target.fillStyle}`);
      }
      if (name === 'fillRect') {
        // Handles are drawn as squares, one ink for all of them.
        return () => {
          const call = `fill ${target.fillStyle}`;
          if (calls.at(-1) !== call) {
            calls.push(call);
          }
        };
      }
      if (name === 'stroke' || name === 'strokeRect') {
        return () => calls.push(`stroke ${target.strokeStyle}`);
      }
      if (name === 'fillText') {
        return (text: string) => calls.push(`fillText:${text} ${target.fillStyle}`);
      }
      return () => undefined;
    },
    set(target, name, value: string) {
      if (name === 'fillStyle' || name === 'strokeStyle') {
        target[name] = value;
      }
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  content.draw(ctx);
  return calls;
}

/** Where a layer draws images: each `drawImage` call's destination rect. */
function drawnImages(layer: CompositionLayer | undefined): number[][] {
  const content = layer?.content;
  if (!isGeometryLayer(content)) {
    throw new Error('not a drawn layer');
  }
  const images: number[][] = [];
  const ctx = new Proxy(
    {},
    {
      get(_target, name) {
        if (name === 'drawImage') {
          return (_source: unknown, ...args: number[]) => images.push(args.slice(-4));
        }
        return () => undefined;
      },
      set: () => true,
    },
  ) as CanvasRenderingContext2D;
  content.draw(ctx);
  return images;
}

function drawn(layer: CompositionLayer | undefined): string[] {
  const content = layer?.content;
  if (!isGeometryLayer(content)) {
    throw new Error('not a drawn layer');
  }
  const calls: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get(_target, name) {
        if (name === 'fill' || name === 'stroke') {
          return () => calls.push(name);
        }
        if (name === 'fillText') {
          return (text: string) => calls.push(`fillText:${text}`);
        }
        return () => undefined;
      },
      set: () => true,
    },
  ) as CanvasRenderingContext2D;
  content.draw(ctx);
  return calls;
}
