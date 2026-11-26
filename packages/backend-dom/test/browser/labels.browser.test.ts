import { afterEach, describe, expect, it } from 'vitest';
import { DOM_ATTRIBUTES } from '../../src/index.js';
import type { Stage } from './fixture.js';
import { stage } from './fixture.js';

let current: Stage | null = null;
afterEach(async () => {
  await current?.dispose();
  current = null;
  delete (window as { swfPwned?: unknown }).swfPwned;
});

const HOSTILE = '<img src="x" onerror="window.swfPwned = true"><b>bold</b>';

describe('labels and host metadata as text (SEC-010, QA-011)', () => {
  it('writes window names as the text they are, whether the window is shown in full or by a proxy', async () => {
    current = await stage(
      [{ id: 'a', heading: 0, distance: 3, label: HOSTILE, surfaceLabel: `${HOSTILE} view` }],
      { viewports: ['v', 'w'] },
    );
    const v = current.views.get('v');
    const w = current.views.get('w');
    const names = (root: HTMLElement | undefined) => [
      ...(root?.querySelectorAll(`[${DOM_ATTRIBUTES.layer}="names"] [${DOM_ATTRIBUTES.label}]`) ??
        []),
    ];
    expect(names(v?.root).map((t) => t.textContent)).toEqual([HOSTILE]);
    expect(w?.root.querySelector(`[${DOM_ATTRIBUTES.layer}="proxy"]`)).not.toBeNull();
    expect(names(w?.root).map((t) => t.textContent)).toEqual([HOSTILE]);
    for (const root of [v?.root, w?.root]) {
      expect(root?.querySelector('img')).toBeNull();
      expect(root?.querySelector('b')).toBeNull();
    }
    // Give a parsed image the chance to fail and run its handler: nothing ran.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((window as { swfPwned?: unknown }).swfPwned).toBeUndefined();
  });

  it('names the window of an unbound surface’s placeholder as text too', async () => {
    current = await stage([{ id: 'a', heading: 0, distance: 3, label: HOSTILE }]);
    await current.runtime.unbind('a-view');
    const update = await current.views.get('v')?.update();
    const placeholder = current.views
      .get('v')
      ?.root.querySelector(`[${DOM_ATTRIBUTES.layer}="placeholder"]`);
    expect(update?.rendered.layers.find((l) => l.surfaceId === 'a-view')?.category).toBe(
      'placeholder',
    );
    expect(placeholder).not.toBeNull();
    const name = current.views
      .get('v')
      ?.root.querySelector(`[${DOM_ATTRIBUTES.layer}="names"] [${DOM_ATTRIBUTES.label}]`);
    expect(name?.textContent).toBe(HOSTILE);
    expect(current.views.get('v')?.root.querySelector('img')).toBeNull();
  });
});

/**
 * How many times `run` sets the font of a 2D context of each kind: of a canvas in a document, and
 * of an offscreen canvas.
 */
async function fontSettings(run: () => Promise<unknown>): Promise<{
  document: number;
  offscreen: number;
}> {
  const counts = { document: 0, offscreen: 0 };
  const protos = [
    ['document', CanvasRenderingContext2D.prototype],
    ['offscreen', OffscreenCanvasRenderingContext2D.prototype],
  ] as const;
  const owns = protos.map(([kind, proto]) => {
    const own = Object.getOwnPropertyDescriptor(proto, 'font');
    const set = own?.set;
    if (own === undefined || set === undefined) {
      throw new Error(`this browser’s ${kind} 2D context has no font to set`);
    }
    Object.defineProperty(proto, 'font', {
      ...own,
      set(this: unknown, value: string) {
        counts[kind] += 1;
        set.call(this, value);
      },
    });
    return [proto, own] as const;
  });
  try {
    await run();
  } finally {
    for (const [proto, own] of owns) {
      Object.defineProperty(proto, 'font', own);
    }
  }
  return counts;
}

describe('the names’ cost', () => {
  it('measures a frame’s names in one setting of the font, on no canvas of the document', async () => {
    // Setting a context's font parses it; a canvas in the document resolves it against the
    // document's style, which WebKit then recalculates in the middle of the frame (3 ms a frame
    // with sixty names over five hundred windows).
    current = await stage(
      Array.from({ length: 24 }, (_, i) => ({
        id: `w${String(i)}`,
        heading: -2.8 + i * 0.24,
        distance: 3 + (i % 4),
        label: `Window ${String(i + 1)}`,
      })),
    );
    const view = current.views.get('v');
    const settings = await fontSettings(async () => view?.update());
    const names = view?.root.querySelectorAll(
      `[${DOM_ATTRIBUTES.layer}="names"] [${DOM_ATTRIBUTES.label}]`,
    );
    expect(names?.length).toBeGreaterThan(5);
    expect(settings).toEqual({ document: 0, offscreen: 1 });
  });
});
