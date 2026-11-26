import { worldMatrix } from '@swf/core';
import type { RepresentationPolicy } from '@swf/presentation';
import { afterEach, describe, expect, it } from 'vitest';
import { DOM_ATTRIBUTES } from '../../src/index.js';
import type { Stage } from './fixture.js';
import { stage } from './fixture.js';

let current: Stage | null = null;
afterEach(async () => {
  await current?.dispose();
  current = null;
});

/** In full nearer than 4 units from the camera, compact to 6, the label alone beyond. */
const byDistance: RepresentationPolicy = {
  id: 'test.depth/1',
  representationOf({ scene, nodeId }) {
    const m = worldMatrix(scene.nodes, nodeId);
    const distance = m === undefined ? 0 : Math.hypot(m[12], m[13], m[14]);
    return distance < 4 ? 'full' : distance < 6 ? 'compact' : 'label';
  },
};

describe('representations in the DOM backend (FR-122, ARCH-025)', () => {
  it('shows a compact window as a framed proxy and a far one as its label alone, the content kept', async () => {
    current = await stage([
      { id: 'near', heading: -0.6, distance: 3, label: 'Near' },
      { id: 'mid', heading: 0, distance: 5, label: 'Mid' },
      { id: 'far', heading: 0.6, distance: 8, label: 'Far' },
    ]);
    const view = current.views.get('v');
    if (view === undefined) {
      throw new Error('no view');
    }
    const elementOf = (key: string) => current?.lives.get(key)?.element;
    const farContent = elementOf('key-far');
    expect(view.presentation('far-view')).toBe('live');
    view.viewport.setRepresentation(byDistance);
    await view.update();
    expect(['near-view', 'mid-view', 'far-view'].map((s) => view.presentation(s))).toEqual([
      'live',
      'proxy',
      'proxy',
    ]);
    const proxy = (surfaceId: string) =>
      view.root.querySelector<HTMLElement>(
        `[${DOM_ATTRIBUTES.layer}="proxy"][${DOM_ATTRIBUTES.surface}="${surfaceId}"]`,
      );
    expect(proxy('mid-view')?.getAttribute(DOM_ATTRIBUTES.representation)).toBe('compact');
    expect(proxy('far-view')?.getAttribute(DOM_ATTRIBUTES.representation)).toBe('label');
    // The far window is marked where it is, and named beside its mark, flat and whole.
    const mark = proxy('far-view')?.querySelector<HTMLElement>(`[${DOM_ATTRIBUTES.mark}]`);
    expect(mark === null || mark === undefined ? '' : getComputedStyle(mark).display).toBe('block');
    const name = (nodeId: string) =>
      view.root.querySelector<HTMLElement>(
        `[${DOM_ATTRIBUTES.layer}="names"] [${DOM_ATTRIBUTES.node}="${nodeId}"]`,
      );
    expect(['near', 'mid', 'far'].map((n) => name(n)?.textContent)).toEqual(['Near', 'Mid', 'Far']);
    const farName = name('far')?.getBoundingClientRect();
    const farMark = mark?.getBoundingClientRect();
    expect(farName !== undefined && farMark !== undefined && farName.left >= farMark.right).toBe(
      true,
    );
    expect(name('far')?.scrollWidth).toBe(name('far')?.clientWidth);
    // A compact window's proxy shows no mark.
    const midMark = proxy('mid-view')?.querySelector<HTMLElement>(`[${DOM_ATTRIBUTES.mark}]`);
    expect(midMark === null || midMark === undefined ? '' : getComputedStyle(midMark).display).toBe(
      'none',
    );
    const mid = proxy('mid-view');
    expect(mid === null ? '' : getComputedStyle(mid).overflow).toBe('hidden');
    const chrome = (nodeId: string) =>
      view.root.querySelector(
        `[${DOM_ATTRIBUTES.layer}="chrome"][${DOM_ATTRIBUTES.node}="${nodeId}"]`,
      );
    expect(chrome('near')).not.toBeNull();
    expect(chrome('mid')).not.toBeNull();
    // The mark stands for the whole window: no frame or handles.
    expect(chrome('far')).toBeNull();
    // The far window's content was neither released nor recreated: still the host's, in the page.
    expect(farContent?.isConnected).toBe(true);
    expect(current.runtime.get('far-view')?.state).toBe('hidden');
    // Without the policy it is live again, the very same element.
    view.viewport.setRepresentation(null);
    await view.update();
    expect(view.presentation('far-view')).toBe('live');
    expect(elementOf('key-far')).toBe(farContent);
    expect(chrome('far')).not.toBeNull();
  });
});
