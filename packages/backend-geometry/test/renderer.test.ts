import { SwfFailure } from '@swf/core';
import type { CompositionLayer, RenderedFrame, RepresentationPolicy } from '@swf/presentation';
import { negotiate } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import type { GeometryInks } from '../src/index.js';
import {
  affine,
  DEFAULT_GEOMETRY_INKS,
  drawableIssue,
  GeometryRenderer,
  homographyMesh,
  isGeometryLayer,
  LAYER_COMPOSITOR_CAPABILITIES,
  LAYER_COMPOSITOR_ID,
  LayeredRenderer,
} from '../src/index.js';
import { rectQuad, rectToQuad } from '@swf/math';
import { plan, scene } from './fixture.js';

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
      'fillText:None',
      'fillText:Unbound: no content is bound',
    ]);
    // Drawn content is itself: nothing is said over it.
    expect(drawn(of(english.rendered, 'drawn-s'))).not.toContain(
      'fillText:Unbound: no content is bound',
    );
    const host = await render(placed, { standIn: (reason) => `[${reason}]` });
    expect(drawn(of(host.rendered, 'none-s'))).toContain('fillText:[unbound]');
  });

  it('never claims drawn content exact: it is warped by a mesh (AC-005, ARCH-012)', async () => {
    const { frame } = await render([{ id: 'drawn', kind: 'drawn', heading: 0, distance: 3 }]);
    const drawn = frame.planned.find((p) => p.fragment.surfaceId === 'drawn-s');
    expect(drawn?.negotiation).toMatchObject({
      mode: 'approximated',
      shapeFidelity: 'approximate',
      contentFidelity: 'approximate',
      layer: 'content-raster',
    });
    expect(drawn?.negotiation.fallback?.gaps).toContainEqual({
      mode: 'exact',
      requirement: 'renderer',
      detail: 'draws drawable content at approximate fidelity',
    });
    expect(frame.planned.every((p) => p.negotiation.shapeFidelity !== 'exact')).toBe(true);
    // Even under an affine projection, the mesh renderer's drawn content is not exact.
    const affineNegotiation = negotiate({
      surfaceId: 's',
      viewportId: 'v',
      surface: frame.planned[0] === undefined ? null : drawnCaps,
      renderer: { id: 'g/1', capabilities: new GeometryRenderer().capabilities() },
      compositor: { id: 'c/1', capabilities: LAYER_COMPOSITOR_CAPABILITIES },
      projection: { id: 'p/1', mapping: 'affine', seamWrapping: false, exactInverse: true },
      geometry: { kind: 'rect', supported: true, fidelity: 'exact' },
      anchor: 'exact',
      owner: true,
    });
    expect(affineNegotiation.mode).toBe('approximated');
  });

  it('stacks each window’s chrome after its last fragment, and indicators on top', async () => {
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
    // The window behind the camera is out of a 120° view: an indicator points the way.
    expect(ids.at(-1)).toBe('overlay:indicators');
    expect(frame.planned.some((p) => p.fragment.surfaceId === 'away-s')).toBe(false);
  });

  it('draws a compact window as its proxy, and a label-only one as its label alone, without chrome (FR-122)', async () => {
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
    const near = drawn(of('near-s'));
    expect(near).toContain('fill');
    expect(near).toContain('fillText:Near');
    // The label alone: its text, no box.
    expect(drawn(of('far-s'))).toEqual(['fillText:Far']);
    const ids = rendered.layers.map((l) => l.id);
    expect(ids).toContain('chrome:near');
    expect(ids).not.toContain('chrome:far');
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
    };
    const renderer = new GeometryRenderer({
      drawables: () => drawable,
      projections,
      inks: () => inks,
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
    // The selected window's frame and its handles, the focused one's frame, any other's frame;
    // each title in the text ink.
    expect(layer('chrome:a')).toEqual([
      'stroke rgb(2, 2, 2)',
      'fillText:A rgb(4, 4, 4)',
      'fill rgb(2, 2, 2)',
    ]);
    expect(layer('chrome:b')).toEqual(['stroke rgb(3, 3, 3)', 'fillText:B rgb(4, 4, 4)']);
    expect(layer('chrome:c')).toEqual(['stroke rgb(1, 1, 1)', 'fillText:C rgb(4, 4, 4)']);
    expect(layer('overlay:indicators')).toEqual([
      'fill rgb(1, 1, 1)',
      'fillText:Away rgb(4, 4, 4)',
    ]);
    // A change of the host's inks (a switch to a dark appearance) is drawn at the next frame.
    inks = { ...inks, frame: 'rgb(9, 9, 9)', text: 'rgb(8, 8, 8)' };
    layer = await draw();
    expect(layer('chrome:c')).toEqual(['stroke rgb(9, 9, 9)', 'fillText:C rgb(8, 8, 8)']);
    expect(DEFAULT_GEOMETRY_INKS).toEqual({
      frame: 'rgb(118, 118, 118)',
      selected: 'rgb(0, 95, 184)',
      focused: 'rgb(168, 74, 0)',
      text: 'rgb(30, 30, 30)',
    });
  });

  it('draws a stand-in’s words on a ground of its own, whatever the view is drawn over', async () => {
    const { rendered } = await render([
      { id: 'prox', kind: 'proxied', heading: 0, distance: 3, label: 'P' },
      { id: 'none', kind: 'unbound', heading: 0.8, distance: 3, label: 'N' },
    ]);
    const of = (surfaceId: string) => inked(rendered.layers.find((l) => l.surfaceId === surfaceId));
    // Opaque grounds, each with an ink 4.5:1 or more on it.
    expect(of('prox-s').slice(0, 3)).toEqual([
      'fill rgb(72, 84, 108)',
      'stroke rgb(48, 56, 72)',
      'fillText:P rgb(255, 255, 255)',
    ]);
    expect(of('none-s').slice(0, 3)).toEqual([
      'fill rgb(220, 220, 220)',
      'stroke rgb(90, 90, 90)',
      'fillText:N rgb(40, 40, 40)',
    ]);
  });

  it('draws content and representations only without projection modules, no chrome', async () => {
    const { rendered } = await render(
      [{ id: 'a', kind: 'drawn', heading: 0, distance: 3 }],
      {},
      360,
      false,
    );
    expect(rendered.layers.map((l) => l.category)).toEqual(['content-raster']);
    expect(new GeometryRenderer().capabilities().transformMode).toBe('perspective-3d');
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
    expect(() => new GeometryRenderer({ meshCells: 0 })).toThrow(RangeError);
  });
});

const drawnCaps = {
  attachStrategy: 'drawable',
  nativeInteraction: 'none',
  uvAddressing: true,
  transformFidelity: 'exact',
  transparency: false,
  clipping: true,
  cursorMapping: true,
  resize: 'intrinsic',
  viewportSharing: 'shared',
  safeDetach: true,
  rebinding: true,
  placeholder: false,
  snapshotHooks: false,
} as const;

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
      handleKinds: { drawable: 'approximate', 'proxy-only': 'proxy', 'native-dom': 'native' },
      transformMode: 'perspective-3d',
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

describe('drawing math', () => {
  it('maps a source triangle exactly onto its destination', () => {
    const m = affine([0, 0], [10, 0], [0, 5], [100, 50], [120, 60], [95, 70]);
    if (m === null) {
      throw new Error('expected a map');
    }
    const apply = ([x, y]: readonly [number, number]) => [
      m[0] * x + m[2] * y + m[4],
      m[1] * x + m[3] * y + m[5],
    ];
    expect(apply([0, 0])).toEqual([100, 50]);
    expect(apply([10, 0])).toEqual([120, 60]);
    expect(apply([0, 5])).toEqual([95, 70]);
    expect(affine([0, 0], [1, 1], [2, 2], [0, 0], [1, 0], [0, 1])).toBeNull();
    // A source triangle away from the origin, as every cell but the first is.
    const n = affine([16, 8], [32, 8], [16, 24], [40, 30], [60, 34], [38, 52]);
    if (n === null) {
      throw new Error('expected a map');
    }
    const applyN = ([x, y]: readonly [number, number]) => [
      n[0] * x + n[2] * y + n[4],
      n[1] * x + n[3] * y + n[5],
    ];
    for (const [s, d] of [
      [
        [16, 8],
        [40, 30],
      ],
      [
        [32, 8],
        [60, 34],
      ],
      [
        [16, 24],
        [38, 52],
      ],
    ] as const) {
      const [x, y] = applyN(s);
      expect(x).toBeCloseTo(d[0], 9);
      expect(y).toBeCloseTo(d[1], 9);
    }
  });

  it('meshes a homography so that its corners are the quad’s', () => {
    const quad = [
      [10, 20],
      [200, 30],
      [190, 140],
      [15, 120],
    ] as const;
    const h = rectToQuad(64, 32, quad);
    if (h === null) {
      throw new Error('expected a map');
    }
    const mesh = homographyMesh(h, 64, 32, 4, 4);
    const corners = [
      mesh.points[0]?.[0],
      mesh.points[0]?.[4],
      mesh.points[4]?.[4],
      mesh.points[4]?.[0],
    ];
    corners.forEach((p, i) => {
      expect(
        Math.hypot(
          (p?.[0] ?? NaN) - (quad[i]?.[0] ?? NaN),
          (p?.[1] ?? NaN) - (quad[i]?.[1] ?? NaN),
        ),
      ).toBeLessThan(1e-9);
    });
    expect(rectToQuad(64, 32, rectQuad([0, 0, 64, 32]))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

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
      if (name === 'stroke') {
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
