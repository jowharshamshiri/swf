import { afterEach, describe, expect, it } from 'vitest';
import { DOM_ATTRIBUTES } from '../../src/index.js';
import type { Stage } from './fixture.js';
import { stage } from './fixture.js';

let current: Stage | null = null;
afterEach(async () => {
  await current?.dispose();
  current = null;
});

const mounted = (key: string) => document.querySelectorAll(`[data-test-content^="${key}"]`).length;

describe('single-owner endpoints (FR-057, FR-065, AC-004)', () => {
  it('shows a single-owner endpoint in a second viewport as a declared proxy, never mounted twice', async () => {
    current = await stage([{ id: 'a', heading: 0, distance: 3, label: 'Notes' }], {
      viewports: ['v', 'w'],
    });
    const v = current.views.get('v');
    const w = current.views.get('w');
    expect(mounted('key-a')).toBe(1);
    expect(v?.presentation('a-view')).toBe('live');
    expect(w?.presentation('a-view')).toBe('proxy');
    const proxy = w?.root.querySelector(`[${DOM_ATTRIBUTES.layer}="proxy"]`);
    expect(proxy?.getAttribute(DOM_ATTRIBUTES.surface)).toBe('a-view');
    expect(proxy?.getAttribute(DOM_ATTRIBUTES.mode)).toBe('proxy');
    // The proxy says why it stands in; the window's name is on its title bar.
    expect(proxy?.textContent).toContain('Shown in another view');
    expect(w?.root.querySelector(`[${DOM_ATTRIBUTES.titleBar}="a"]`)?.textContent).toBe('Notes');
    expect(w?.root.querySelector('[data-test-content]')).toBeNull();
    // The second view planned a proxy from the start: nothing was refused there, and updating
    // either view again changes nothing about who holds it.
    const again = await w?.update();
    expect(again?.refused).toEqual([]);
    expect(again?.presented).toEqual([]);
    await v?.update();
    expect(mounted('key-a')).toBe(1);
    expect(current.runtime.get('a-view')?.viewports.map((x) => x.viewportId)).toEqual(['v']);
  });

  it('settles a race for one endpoint: one view mounts it, the other is refused and shows a proxy', async () => {
    current = await stage([{ id: 'a', heading: 0, distance: 3 }], {
      viewports: ['v', 'w'],
      update: false,
    });
    const [first, second] = await Promise.all([
      current.views.get('v')?.update(),
      current.views.get('w')?.update(),
    ]);
    expect(mounted('key-a')).toBe(1);
    const updates = [first, second];
    const live = updates.filter((u) => u?.presented.includes('a-view'));
    const refused = updates.filter((u) => (u?.refused.length ?? 0) > 0);
    expect(live).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.refused[0]?.error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(refused[0]?.rendered.layers.find((l) => l.surfaceId === 'a-view')?.category).toBe(
      'proxy',
    );
  });

  it('mounts an endpoint that declares itself shareable in every viewport', async () => {
    current = await stage([{ id: 'a', heading: 0, distance: 3 }], {
      viewports: ['v', 'w'],
      sharing: 'shared',
    });
    expect(mounted('key-a')).toBe(2);
    expect(current.views.get('w')?.presentation('a-view')).toBe('live');
  });

  it('hides a surface that leaves the view without moving it, and shows it again in place', async () => {
    current = await stage([{ id: 'a', heading: 0, distance: 3 }]);
    const view = current.views.get('v');
    const live = current.lives.get('key-a');
    const parent = live?.element.parentElement;
    expect(
      current.ws.dispatch({ type: 'node.patch', id: 'a', flags: { visible: false } }).status,
    ).toBe('committed');
    const hidden = await view?.update();
    expect(hidden?.hidden).toEqual(['a-view']);
    expect(current.runtime.get('a-view')?.state).toBe('hidden');
    expect(getComputedStyle(parent?.parentElement ?? document.body).display).toBe('none');
    expect(
      current.ws.dispatch({ type: 'node.patch', id: 'a', flags: { visible: true } }).status,
    ).toBe('committed');
    const shown = await view?.update();
    expect(shown?.presented).toEqual(['a-view']);
    expect(live?.element.parentElement).toBe(parent);
    expect(mounted('key-a')).toBe(1);
  });

  it('releases its attachments when disposed, leaving the endpoint itself alone', async () => {
    current = await stage([{ id: 'a', heading: 0, distance: 3 }]);
    const view = current.views.get('v');
    const live = current.lives.get('key-a');
    expect(await view?.dispose()).toEqual({ retained: [] });
    expect(current.runtime.get('a-view')?.viewports).toEqual([]);
    expect(live?.element.isConnected).toBe(false);
    expect(current.containers.get('v')?.childElementCount).toBe(0);
    await expect(view?.update()).rejects.toThrow(/disposed/);
  });
});
