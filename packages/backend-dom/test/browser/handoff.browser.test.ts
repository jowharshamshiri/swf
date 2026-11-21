import { afterEach, describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { DOM_ATTRIBUTES } from '../../src/index.js';
import type { Stage } from './fixture.js';
import { drag, onWindow, pageOf, screenOf, stage } from './fixture.js';

let current: Stage | null = null;
afterEach(async () => {
  await current?.dispose();
  current = null;
});

const framed = { id: 'a', heading: 0, distance: 3, size: [3, 2] as const, inset: 1 };

/** Waits for a condition the presenter reaches on its own, polling each animation frame. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  if (!condition()) {
    throw new Error(`timed out waiting for ${what}`);
  }
}

describe('losing the renderer in an active scene (§33.2 scenario 6, NFR-013, §27)', () => {
  it('degrades visibly, keeps taking input, and resumes with the layout intact', async () => {
    current = await stage([framed]);
    const s = current;
    const view = s.views.get('v');
    const live = s.lives.get('key-a');
    if (view === undefined || live === undefined) {
      throw new Error('no view');
    }
    expect(view.presentation('a-view')).toBe('live');

    // The renderer goes away with nothing to fall back to.
    s.backend.unregister();
    await until(() => view.viewport.state === 'presentation-degraded', 'degradation');
    const notice = view.root.querySelector(`[${DOM_ATTRIBUTES.degraded}]`);
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toMatch(/^Presentation unavailable: viewport "v"/);
    // Its live content left the view, released (the endpoint allows it), never destroyed.
    expect(live.element.isConnected).toBe(false);
    expect(s.runtime.get('a-view')?.viewports).toEqual([]);
    expect(view.presentation('a-view')).toBe('proxy');

    // The scene still takes input: dragging the window's frame moves it.
    const before = s.ws.getState().nodes.get('a')?.transform.position ?? [0, 0, 0];
    const start = screenOf(s, onWindow(s, 'a', [0, 0.6, 0]));
    await drag(view.root, start, [
      [start[0] + 30, start[1]],
      [start[0] + 60, start[1] + 10],
    ]);
    const moved = s.ws.getState().nodes.get('a')?.transform.position ?? [0, 0, 0];
    expect(moved[0]).toBeGreaterThan(before[0] + 0.1);

    // The renderer comes back: the viewport resumes by itself, with what was committed meanwhile.
    s.registry.registerRenderer(s.backend.renderer);
    await until(() => view.viewport.state === 'active', 'resuming');
    await view.update();
    expect(view.root.querySelector(`[${DOM_ATTRIBUTES.degraded}]`)).toBeNull();
    expect(view.presentation('a-view')).toBe('live');
    expect(document.querySelectorAll('[data-test-content="key-a"]')).toHaveLength(1);
    expect(s.ws.getState().nodes.get('a')?.transform.position).toEqual(moved);

    // And the content takes the browser's own input again.
    const [cx, cy] = screenOf(s, onWindow(s, 'a', [0, 0.1, 0]));
    const [px, py] = pageOf(view.root, cx, cy);
    expect(document.elementFromPoint(px, py)).toBe(live.button);
    await commands.mouse('move', px, py);
    await commands.mouse('down', px, py);
    await commands.mouse('up', px, py);
    expect(live.received).toContainEqual({ type: 'click', trusted: true });
  });
});
