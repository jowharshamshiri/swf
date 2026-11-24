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
    expect(proxy('far-view')?.textContent).toBe('Far');
    // The label is whole, even where the window is smaller than it.
    const far = proxy('far-view');
    expect(far === null ? '' : getComputedStyle(far).overflow).toBe('visible');
    expect(far === null ? '' : getComputedStyle(far).whiteSpace).toBe('nowrap');
    const mid = proxy('mid-view');
    expect(mid === null ? '' : getComputedStyle(mid).overflow).toBe('hidden');
    const chrome = (nodeId: string) =>
      view.root.querySelector(
        `[${DOM_ATTRIBUTES.layer}="chrome"][${DOM_ATTRIBUTES.node}="${nodeId}"]`,
      );
    expect(chrome('near')).not.toBeNull();
    expect(chrome('mid')).not.toBeNull();
    // The label stands for the whole window: no frame, title or handles.
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
