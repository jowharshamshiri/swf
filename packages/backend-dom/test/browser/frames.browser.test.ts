import type { PresenterEvent } from '@swf/presentation';
import { quatFromAxisAngle } from '@swf/math';
import { afterEach, describe, expect, it } from 'vitest';
import type { Stage } from './fixture.js';
import { stage } from './fixture.js';

let current: Stage | null = null;
afterEach(async () => {
  await current?.dispose();
  current = null;
});

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** Every change the browser saw under `root` while `work` ran. */
async function mutations(
  root: HTMLElement,
  work: () => Promise<unknown>,
): Promise<MutationRecord[]> {
  const seen: MutationRecord[] = [];
  const observer = new MutationObserver((records) => seen.push(...records));
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  await work();
  seen.push(...observer.takeRecords());
  observer.disconnect();
  return seen;
}

const at = (heading: number) => ({
  position: [3 * Math.sin(heading), 0, -3 * Math.cos(heading)] as [number, number, number],
  rotation: quatFromAxisAngle([0, 1, 0], -heading),
  scale: [1, 1, 1] as [number, number, number],
});

describe('frames in a real browser (FR-143, NFR-005, NFR-009)', () => {
  it('writes nothing to the DOM for a frame where nothing changed, and only the moved window’s parts otherwise', async () => {
    current = await stage([
      { id: 'a', heading: -0.6, distance: 3, label: 'A' },
      { id: 'b', heading: 0.6, distance: 3, label: 'B' },
    ]);
    const view = current.views.get('v');
    if (view === undefined) {
      throw new Error('no view');
    }
    const still = await mutations(view.root, async () => {
      view.viewport.invalidate();
      const frame = await view.update();
      expect(frame.metrics.writes).toBe(0);
    });
    expect(still).toEqual([]);
    const ws = current.ws;
    const moved = await mutations(view.root, async () => {
      ws.dispatch({ type: 'node.patch', id: 'b', transform: at(0.7) });
      const frame = await view.update();
      expect(frame.metrics.writes).toBeGreaterThan(0);
    });
    expect(moved.length).toBeGreaterThan(0);
    // Every element written belongs to window b: its content slot or its chrome.
    const owners = new Set(
      moved.map((m) => {
        const element = m.target instanceof Element ? m.target : m.target.parentElement;
        return (
          element?.closest('[data-swf-surface]')?.getAttribute('data-swf-surface') ??
          element?.closest('[data-swf-node]')?.getAttribute('data-swf-node')
        );
      }),
    );
    expect([...owners]).toEqual(expect.arrayContaining(['b']));
    expect([...owners].every((o) => o === 'b' || o === 'b-view')).toBe(true);
  });

  it('coalesces a burst of drag previews to animation frames, presenting only the latest', async () => {
    current = await stage([{ id: 'a', heading: 0, distance: 3 }], { animationFrames: true });
    const s = current;
    const events: PresenterEvent[] = [];
    s.presenter.subscribe((e) => events.push(e));
    const previews: number[] = [];
    s.ws.subscribe((e) => {
      if (e.type === 'transform.preview') {
        previews.push(e.revision);
      }
    });
    await nextFrame();
    await nextFrame();
    events.length = 0;
    // Sixty pointer moves inside one task: one preview each.
    for (let i = 1; i <= 60; i++) {
      s.ws.preview('drag', [{ type: 'node.patch', id: 'a', transform: at(i / 200) }], {
        source: 'user',
      });
    }
    expect(previews).toEqual([]);
    for (let i = 0; i < 4; i++) {
      await nextFrame();
    }
    // One preview event, and a frame or two (never sixty), showing where the drag is now.
    expect(previews).toHaveLength(1);
    const frames = events.filter((e) => e.type === 'frame');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(2);
    const shown = s.views.get('v')?.viewport.lastFrame()?.frame.scene.nodes.get('a');
    expect(shown?.transform.position[0]).toBeCloseTo(3 * Math.sin(60 / 200));
    // The preview is shown, not committed.
    expect(s.ws.getState().nodes.get('a')?.transform.position[0]).toBeCloseTo(0);
  });

  it('presents a drag preview in the animation frame that announces it, not the frame after (NFR-004)', async () => {
    current = await stage([{ id: 'a', heading: 0, distance: 3 }], { animationFrames: true });
    const s = current;
    for (let trial = 0; trial < 5; trial++) {
      await nextFrame();
      // A pointer move between frames previews the window.
      s.ws.preview('drag', [{ type: 'node.patch', id: 'a', transform: at((trial + 1) / 100) }], {
        source: 'user',
      });
      const announced = new Promise<number>((resolve) => {
        const stop = s.ws.subscribe((e) => {
          if (e.type === 'transform.preview') {
            stop();
            resolve(Number(document.timeline.currentTime));
          }
        });
      });
      const presented = new Promise<number>((resolve) => {
        const stop = s.presenter.subscribe((e) => {
          if (e.type === 'frame') {
            stop();
            resolve(Number(document.timeline.currentTime));
          }
        });
      });
      const [when, shown] = await Promise.all([announced, presented]);
      // Both happen in the same animation frame, whose time they share.
      expect(shown).toBe(when);
      const position = s.views.get('v')?.viewport.lastFrame()?.frame.scene.nodes.get('a')?.transform
        .position[0];
      expect(position).toBeCloseTo(3 * Math.sin((trial + 1) / 100));
    }
  });
});
