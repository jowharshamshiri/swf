import type { ProjectedFragment } from '@swf/presentation';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomViewUpdate } from '../../src/index.js';
import { DOM_ATTRIBUTES } from '../../src/index.js';
import type { Stage } from './fixture.js';
import { onWindow, pageOf, screenOf, stage, W } from './fixture.js';

let current: Stage | null = null;
afterEach(async () => {
  await current?.dispose();
  current = null;
});

/** Where the slot's box corners land on the page, read from zero-size probes inside it. */
function slotCorners(slot: HTMLElement): [number, number][] {
  const w = parseFloat(slot.style.width);
  const h = parseFloat(slot.style.height);
  return (
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ] as const
  ).map(([x, y]) => {
    const probe = document.createElement('div');
    probe.style.setProperty('position', 'absolute');
    probe.style.setProperty('left', `${String(x)}px`);
    probe.style.setProperty('top', `${String(y)}px`);
    probe.style.setProperty('width', '0px');
    probe.style.setProperty('height', '0px');
    slot.append(probe);
    const box = probe.getBoundingClientRect();
    probe.remove();
    return [box.left, box.top];
  });
}

function nativeFragment(update: DomViewUpdate, surfaceId: string): ProjectedFragment {
  const planned = update.frame.planned.find(
    (p) => p.fragment.surfaceId === surfaceId && p.negotiation.layer === 'content-native',
  );
  if (planned === undefined) {
    throw new Error(`no live fragment for ${surfaceId}`);
  }
  return planned.fragment;
}

describe('live DOM placement (FR-084, FR-086, ARCH-010, ARCH-012)', () => {
  it('maps the live element onto its projected corners, declaring the shape approximate', async () => {
    current = await stage([{ id: 'a', heading: 0.3, distance: 3 }]);
    const view = current.views.get('v');
    const update = await view?.update();
    if (view === undefined || update === undefined) {
      throw new Error('no view');
    }
    const fragment = nativeFragment(update, 'a-view');
    const slot = view.root.querySelector<HTMLElement>(`[${DOM_ATTRIBUTES.slot}="a-view"]`);
    if (slot === null || fragment.corners === null) {
      throw new Error('no slot or corners');
    }
    const root = view.root.getBoundingClientRect();
    slotCorners(slot).forEach(([x, y], i) => {
      const [cx, cy] = fragment.corners?.[i] ?? [NaN, NaN];
      expect(Math.abs(x - root.left - cx)).toBeLessThan(0.75);
      expect(Math.abs(y - root.top - cy)).toBeLessThan(0.75);
    });
    // The live element lays out at the surface's size (1.6 × 0.8 units at 400 px per unit).
    expect(slot.style.width).toBe('640px');
    expect(slot.style.height).toBe('320px');
    // A panorama bends a planar element: it is placed exactly but its shape only approximated.
    const clip = slot.parentElement;
    expect(clip?.getAttribute(DOM_ATTRIBUTES.mode)).toBe('approximated');
    expect(clip?.getAttribute(DOM_ATTRIBUTES.anchor)).toBe('exact');
    expect(clip?.getAttribute(DOM_ATTRIBUTES.shape)).toBe('approximate');
    expect(clip?.getAttribute(DOM_ATTRIBUTES.placement)).toBe('corners');
    expect(update.frame.planned.every((p) => p.negotiation.shapeFidelity !== 'exact')).toBe(true);
    // The live element really is in the slot, mounted once.
    expect(slot.querySelectorAll('[data-test-content="key-a"]')).toHaveLength(1);
  });

  it('shows a seam-split surface live in its owner piece only, clipped there, and a proxy in the other', async () => {
    current = await stage([{ id: 's', heading: Math.PI - 0.1, distance: 3 }]);
    const view = current.views.get('v');
    const update = await view?.update();
    if (view === undefined || update === undefined) {
      throw new Error('no view');
    }
    const layers = update.rendered.layers.filter((l) => l.surfaceId === 's-view');
    expect(layers.map((l) => l.category).sort()).toEqual(['content-native', 'proxy']);
    expect(document.querySelectorAll('[data-test-content="key-s"]')).toHaveLength(1);
    const owner = nativeFragment(update, 's-view');
    const clip = view.root.querySelector<HTMLElement>(
      `[${DOM_ATTRIBUTES.layer}="content-native"][${DOM_ATTRIBUTES.surface}="s-view"]`,
    );
    // The clip box is the owner piece's visible bounds (styles keep three decimals); the slot
    // inside reaches past the seam.
    expect(parseFloat(clip?.style.left ?? '')).toBeCloseTo(owner.bounds[0], 2);
    expect(parseFloat(clip?.style.width ?? '')).toBeCloseTo(owner.bounds[2], 2);
    expect(getComputedStyle(clip ?? document.body).overflow).toBe('hidden');
    const slot = clip?.querySelector<HTMLElement>(`[${DOM_ATTRIBUTES.slot}]`);
    const root = view.root.getBoundingClientRect();
    const xs = slotCorners(slot ?? document.body).map(([x]) => x - root.left);
    expect(Math.min(...xs) < 0 || Math.max(...xs) > W).toBe(true);
    const proxy = view.root.querySelector(`[${DOM_ATTRIBUTES.layer}="proxy"]`);
    expect(proxy?.getAttribute(DOM_ATTRIBUTES.surface)).toBe('s-view');
    expect(current.views.get('v')?.presentation('s-view')).toBe('live');
  });

  it('keeps the live element in place (never re-parented) as the view changes', async () => {
    current = await stage([{ id: 'a', heading: 0, distance: 3 }]);
    const live = current.lives.get('key-a');
    const parent = live?.element.parentElement;
    const clip = parent?.parentElement;
    // A frame reloads whenever its element is moved in the document: count its loads.
    const frame = document.createElement('iframe');
    let loads = 0;
    const loaded = new Promise((resolve) => {
      frame.addEventListener('load', resolve, { once: true });
    });
    frame.addEventListener('load', () => {
      loads += 1;
    });
    frame.src = 'about:blank';
    live?.element.append(frame);
    await loaded;
    // Turn the camera so the window passes behind the seam and back.
    for (const heading of [1, 2.5, Math.PI, -2.5, 0]) {
      expect(
        current.ws.dispatch({
          type: 'camera.patch',
          id: 'cam',
          rotation: [0, Math.sin(-heading / 2), 0, Math.cos(-heading / 2)],
        }).status,
      ).toBe('committed');
      await current.views.get('v')?.update();
      expect(live?.element.parentElement).toBe(parent);
      expect(parent?.parentElement).toBe(clip);
    }
    expect(document.querySelectorAll('[data-test-content="key-a"]')).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loads).toBe(1);
  });

  it('orders layers by explicit stacking that follows the plan, not by DOM position', async () => {
    current = await stage([
      { id: 'far', heading: 0, distance: 6, size: [4, 2.4] },
      { id: 'near', heading: 0, distance: 3 },
    ]);
    const update = await current.views.get('v')?.update();
    const order = update?.composed.order ?? [];
    const z = (id: string) => {
      const layer = update?.rendered.layers.find((l) => l.id === id);
      return Number((layer?.content as HTMLElement).style.zIndex);
    };
    const zs = order.map(z);
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
    // The nearer window's content stacks above the farther one's.
    const native = order.filter((id) => id.startsWith('content-native:'));
    expect(native.map((id) => id.includes('far-view'))).toEqual([true, false]);
    // Its chrome comes right after its own content: above it, below the nearer window.
    const farChrome = order.indexOf('chrome:far');
    expect(farChrome).toBe(order.findIndex((id) => id.includes('far-view')) + 1);
  });

  it('restacks windows that swap depth, without moving their elements', async () => {
    const s = await stage([
      { id: 'a', heading: 0, distance: 3 },
      { id: 'b', heading: 0.05, distance: 4, size: [2.6, 1.6] },
    ]);
    current = s;
    const view = s.views.get('v');
    if (view === undefined) {
      throw new Error('no view');
    }
    const contentAt = (local: [number, number, number]) => {
      const [x, y] = pageOf(view.root, ...screenOf(s, onWindow(s, 'a', local)));
      return document
        .elementFromPoint(x, y)
        ?.closest('[data-test-content]')
        ?.getAttribute('data-test-content');
    };
    // Where both windows cover the view, the nearer one is on top.
    expect(contentAt([0.2, 0, 0])).toBe('key-a');
    // Send `a` behind `b`: its elements keep their place in the document, its stacking changes.
    const elementA = s.lives.get('key-a')?.element;
    expect(
      s.ws.dispatch({
        type: 'node.patch',
        id: 'a',
        transform: { position: [0, 0, -5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      }).status,
    ).toBe('committed');
    await view.update();
    expect(contentAt([0.2, 0, 0])).toBe('key-b');
    expect(s.lives.get('key-a')?.element).toBe(elementA);
  });
});
