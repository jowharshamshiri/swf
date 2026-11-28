import type { RenderedFrame, RepresentationPolicy } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import {
  GeometryRenderer,
  isGeometryLayer,
  LAYER_COMPOSITOR_CAPABILITIES,
  LAYER_COMPOSITOR_ID,
} from '../../src/index.js';
import type { Placed } from '../fixture.js';
import { H, plan, scene, W } from '../fixture.js';

/** A drawable to draw: one canvas, the same for every surface. */
const drawable = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  return { source: canvas, width: 64, height: 32 };
})();

/** A text drawn on a canvas, by what it says and the box its letters take. */
interface Written {
  readonly text: string;
  readonly box: readonly [number, number, number, number];
}

/**
 * Every text a frame's drawn layers write, each by the box its letters take as the browser
 * measures them in the font, alignment and baseline it is written with.
 */
function writtenIn(rendered: RenderedFrame): Written[] {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const real = canvas.getContext('2d');
  if (real === null) {
    throw new Error('no 2D context');
  }
  const written: Written[] = [];
  const ctx = new Proxy(real, {
    get(target, name) {
      if (name === 'fillText') {
        return (text: string, x: number, y: number) => {
          const m = target.measureText(text);
          const left =
            target.textAlign === 'center'
              ? x - m.width / 2
              : target.textAlign === 'right' || target.textAlign === 'end'
                ? x - m.width
                : x;
          written.push({
            text,
            box: [
              left,
              y - m.actualBoundingBoxAscent,
              m.width,
              m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
            ],
          });
          target.fillText(text, x, y);
        };
      }
      const value: unknown = Reflect.get(target, name, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
    set(target, name, value) {
      return Reflect.set(target, name, value, target);
    },
  });
  for (const layer of rendered.layers) {
    if (isGeometryLayer(layer.content)) {
      ctx.save();
      layer.content.draw(ctx);
      ctx.restore();
    }
  }
  return written;
}

/** The box a layer paints, from its pixels drawn alone on a clear canvas; null if it paints none. */
function paintedBox(content: unknown): readonly [number, number, number, number] | null {
  if (!isGeometryLayer(content)) {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) {
    throw new Error('no 2D context');
  }
  content.draw(ctx);
  const { data } = ctx.getImageData(0, 0, W, H);
  let [left, top, right, bottom] = [W, H, -1, -1];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((data[(y * W + x) * 4 + 3] ?? 0) > 0) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return right < 0 ? null : [left, top, right + 1 - left, bottom + 1 - top];
}

/** Each pair of texts whose letters overlap, and each text not wholly inside the view. */
function collisions(written: readonly Written[]): string[] {
  const found: string[] = [];
  written.forEach((a, i) => {
    const [ax, ay, aw, ah] = a.box;
    if (ax < 0 || ay < 0 || ax + aw > W || ay + ah > H) {
      found.push(`"${a.text}" runs off the view`);
    }
    for (const b of written.slice(i + 1)) {
      const [bx, by, bw, bh] = b.box;
      if (ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah) {
        found.push(`"${a.text}" over "${b.text}"`);
      }
    }
  });
  return found;
}

/**
 * How many times `run` sets the font of a 2D context of an offscreen canvas (where the renderer
 * measures names), and what `run` gives.
 */
async function fontSettings<T>(run: () => Promise<T>): Promise<{ settings: number; result: T }> {
  const proto = OffscreenCanvasRenderingContext2D.prototype;
  const own = Object.getOwnPropertyDescriptor(proto, 'font');
  const set = (own === undefined ? undefined : Reflect.get(own, 'set')) as
    ((this: unknown, value: string) => void) | undefined;
  if (own === undefined || set === undefined) {
    throw new Error('this browser’s offscreen 2D context has no font to set');
  }
  let settings = 0;
  Object.defineProperty(proto, 'font', {
    ...own,
    set(this: OffscreenCanvasRenderingContext2D, value: string) {
      settings += 1;
      set.call(this, value);
    },
  });
  try {
    const result = await run();
    return { settings, result };
  } finally {
    Object.defineProperty(proto, 'font', own);
  }
}

async function rendered(
  placed: readonly Placed[],
  horizontal: number,
  representation?: RepresentationPolicy,
): Promise<RenderedFrame> {
  const { ws, projections, kinds } = scene(placed, horizontal);
  const renderer = new GeometryRenderer({ drawables: () => drawable, projections });
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
  return session.render(frame);
}

describe('names over a drawn view', () => {
  it('writes the names of windows crowded beyond one edge of a narrow view each legibly, none over another', async () => {
    // Eight windows close together a little way past the right edge of a 90° view, and three
    // in view: the marks at the edge point to the eight from nearly the same place.
    const crowded: Placed[] = Array.from({ length: 8 }, (_, i) => ({
      id: `away-${String(i)}`,
      kind: 'drawn',
      heading: 1.4 + i * 0.03,
      distance: 3 + (i % 3),
      y: (i % 2) * 0.3,
      label: `Window out of view ${String(i + 1)}`,
    }));
    const inView: Placed[] = [
      { id: 'a', kind: 'drawn', heading: 0, distance: 3, label: 'Straight ahead' },
      { id: 'b', kind: 'drawn', heading: 0.5, distance: 4, label: 'To the right' },
      { id: 'c', kind: 'drawn', heading: -0.5, distance: 6, label: 'To the left' },
    ];
    const frame = await rendered([...inView, ...crowded], 90);
    const written = writtenIn(frame);
    const texts = written.map((w) => w.text);
    for (const { label } of inView) {
      expect(texts).toContain(label);
    }
    // Every window out of view is named at the edge, or counted there.
    const named = crowded.filter(({ label }) => texts.includes(label ?? ''));
    const counted = texts
      .filter((t) => /^\+\d+$/.test(t))
      .reduce((n, t) => n + Number(t.slice(1)), 0);
    expect(named.length + counted).toBe(crowded.length);
    expect(named.length).toBeGreaterThan(4);
    expect(collisions(written)).toEqual([]);
  });

  it('counts the windows out of view that an edge has no room to name', async () => {
    const crowded: Placed[] = Array.from({ length: 40 }, (_, i) => ({
      id: `away-${String(i)}`,
      kind: 'drawn',
      heading: 1.4 + i * 0.01,
      distance: 3,
      label: `Window out of view ${String(i + 1)}`,
    }));
    const written = writtenIn(await rendered(crowded, 90));
    const texts = written.map((w) => w.text);
    const named = crowded.filter(({ label }) => texts.includes(label ?? '')).length;
    const counted = texts
      .filter((t) => /^\+\d+$/.test(t))
      .reduce((n, t) => n + Number(t.slice(1)), 0);
    expect(counted).toBeGreaterThan(0);
    expect(named + counted).toBe(crowded.length);
    expect(collisions(written)).toEqual([]);
  });

  it('measures a frame’s names in one setting of the font, however many names it writes', async () => {
    // Setting a 2D context's font parses it: in WebKit a frame of sixty names spent more time
    // setting the font than measuring the names.
    const many: Placed[] = Array.from({ length: 30 }, (_, i) => ({
      id: `w-${String(i)}`,
      kind: 'drawn',
      heading: -1.2 + i * 0.09,
      distance: 3 + (i % 4),
      label: `Window ${String(i + 1)}`,
    }));
    const { settings, result } = await fontSettings(() => rendered(many, 90));
    expect(writtenIn(result).length).toBeGreaterThan(10);
    expect(settings).toBe(1);
  });

  it('keeps every name beside a mark clear of every other window’s frame as drawn, in a narrow view', async () => {
    // Near windows in a narrow view, each surface smaller than its window, the middle row shown by
    // its label alone: each other window's frame is drawn round its card and title bar.
    const placed: Placed[] = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        placed.push({
          id: `w-${String(i)}-${String(j)}`,
          kind: 'drawn',
          heading: -0.45 + i * 0.3,
          distance: 2.2 + ((i + j) % 3) * 0.6,
          y: -0.9 + j * 0.9,
          size: [1.6, 0.7],
          inset: 0.3,
          label: `Window ${String(i)}${String(j)}`,
        });
      }
    }
    const frame = await rendered(placed, 70, {
      id: 'test.rows/1',
      representationOf: ({ nodeId }) => (nodeId.endsWith('-1') ? 'label' : 'full'),
    });
    // The names written beside marks and at the view's edge; each title bar names its own window
    // over whatever lies under it.
    const written = writtenIn({
      ...frame,
      layers: frame.layers.filter((l) => l.id !== 'overlay:bars'),
    });
    const owners = new Map(placed.map((p) => [p.label, p.id]));
    const frames = frame.layers.flatMap((l) => {
      const box = l.id.startsWith('chrome:') ? paintedBox(l.content) : null;
      return box === null ? [] : [{ id: l.id.slice('chrome:'.length), box }];
    });
    expect(frames.length).toBeGreaterThan(6);
    expect(written.length).toBeGreaterThan(2);
    const over: string[] = [];
    for (const {
      text,
      box: [ax, ay, aw, ah],
    } of written) {
      for (const {
        id,
        box: [bx, by, bw, bh],
      } of frames) {
        if (
          owners.get(text) !== id &&
          ax < bx + bw &&
          bx < ax + aw &&
          ay < by + bh &&
          by < ay + ah
        ) {
          over.push(`"${text}" over the frame of ${id}`);
        }
      }
    }
    expect(over).toEqual([]);
    expect(collisions(written)).toEqual([]);
  });
});
