import type { Workspace } from '@swf/core';
import { cameraRotation } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import type { OverviewEntry, OverviewLayout } from '@swf/navigation';
import { categoryOf } from '../src/presets.js';
import {
  CAMERA_ID,
  CARD,
  CARD_SCALES,
  aroundCamera,
  layOverview,
  overviewScene,
  regroupWindow,
} from '@swf/navigation';
import { policyWorld, VIEWPORT } from './policy-world.js';

/** A board about the size the overview has in the reference application's centre. */
const BOARD = { width: 620, height: 460 };

const laid = (layout: OverviewLayout) => {
  if (layout.kind !== 'laid') {
    throw new Error('the board is crowded');
  }
  return layout;
};

/** The overview of a workspace as it is now: what the overview reads, and where its cards stand. */
function overviewOf(ws: Workspace, board = BOARD) {
  const scene = overviewScene(ws.getPresented(), VIEWPORT, categoryOf);
  return { scene, layout: layOverview(scene.entries, board.width, board.height) };
}

const entry = (entries: readonly OverviewEntry[], id: string) => {
  const found = entries.find((e) => e.id === id);
  if (found === undefined) {
    throw new Error(`no card for "${id}"`);
  }
  return found;
};

describe('the spatial overview (a dense, spatially meaningful overview of every window)', () => {
  it('shows every active window once, where it stands round the camera, with its groups and parts', () => {
    const { ws } = policyWorld('studio');
    const { scene } = overviewOf(ws);
    const windows = [...ws.getState().nodes.values()].filter((n) => n.kind === 'window');
    expect(scene.entries.map((e) => e.id).sort()).toEqual(windows.map((n) => n.id).sort());
    // The board straight ahead, composed of three surfaces; the reading list straight behind.
    const board = entry(scene.entries, 'board');
    expect(board.label).toBe('Project Board');
    expect(Math.abs(board.heading)).toBeLessThan(1);
    expect(board.behind).toBe(false);
    expect(board.parts).toBe(3);
    expect(board.category).toBe('Planning');
    expect(entry(scene.entries, 'reading').behind).toBe(true);
    // In no group of their own: the workspace holds them all.
    expect(scene.groups).toEqual([]);
    expect(board.group).toBeNull();
    // Headings are the camera's: turned a quarter right, the board is a quarter to the left.
    ws.dispatch({
      type: 'camera.patch',
      id: CAMERA_ID,
      rotation: cameraRotation(Math.PI / 2, 0),
    });
    expect(entry(overviewOf(ws).scene.entries, 'board').heading).toBeCloseTo(-90, 6);
  });

  it('names the group a window is in, and the groups in one order', () => {
    const { ws } = policyWorld('studio');
    const eye = ws.getState().cameras.get(CAMERA_ID)?.position;
    if (eye === undefined) throw new Error('the studio has no camera');
    for (const id of ['reading', 'archive']) {
      const target =
        ws.getState().nodes.get('research') === undefined
          ? ({ kind: 'new', id: 'research', label: 'Research' } as const)
          : ({ kind: 'group', id: 'research' } as const);
      const plan = regroupWindow(ws.getState(), id, target, eye);
      if (plan.kind !== 'plan') throw new Error(`could not regroup "${id}"`);
      expect(ws.transaction(plan.commands).status).toBe('committed');
    }
    const { scene } = overviewOf(ws);
    expect(scene.groups).toEqual([{ id: 'research', label: 'Research' }]);
    expect(entry(scene.entries, 'reading').group).toEqual({ id: 'research', label: 'Research' });
    expect(entry(scene.entries, 'archive').group).toEqual({ id: 'research', label: 'Research' });
    expect(entry(scene.entries, 'board').group).toBeNull();
  });

  it('lays every card on the board, across at its heading, never overlapping, the higher window above', () => {
    const { ws } = policyWorld('studio');
    const { scene, layout } = overviewOf(ws);
    const { cards, width, height } = laid(layout);
    expect(cards.map((c) => c.id).sort()).toEqual(scene.entries.map((e) => e.id).sort());
    const at = new Map(cards.map((c) => [c.id, c]));
    for (const card of cards) {
      // Wholly on the board.
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.y).toBeGreaterThanOrEqual(0);
      expect(card.x + width).toBeLessThanOrEqual(BOARD.width);
      expect(card.y + height).toBeLessThanOrEqual(BOARD.height);
      // Across the board exactly where the heading puts it, to the pixel.
      const e = entry(scene.entries, card.id);
      const expected = Math.floor(
        (Math.round((e.heading + 180) * 10) * (BOARD.width - width)) / 3600,
      );
      expect(card.x).toBe(expected);
    }
    // Left to right in the order of their headings.
    const byHeading = [...scene.entries].sort((a, b) => a.heading - b.heading);
    for (let i = 1; i < byHeading.length; i++) {
      const [a, b] = [byHeading[i - 1], byHeading[i]];
      if (a === undefined || b === undefined) throw new Error('no entry');
      expect(at.get(a.id)?.x ?? NaN).toBeLessThanOrEqual(at.get(b.id)?.x ?? NaN);
    }
    // No two cards overlap; of two side by side, the higher window's stands above.
    for (const a of cards) {
      for (const b of cards) {
        if (a === b) continue;
        const side = a.x < b.x + width && b.x < a.x + width;
        if (!side) continue;
        expect(a.y + height <= b.y || b.y + height <= a.y, `${a.id} and ${b.id}`).toBe(true);
        const [ea, eb] = [entry(scene.entries, a.id), entry(scene.entries, b.id)];
        if (Math.round(ea.elevation * 10) < Math.round(eb.elevation * 10)) {
          expect(a.y, `${a.id} is lower than ${b.id}`).toBeGreaterThan(b.y);
        }
      }
    }
  });

  it('takes the largest card size that holds every card, and is crowded only where none does', () => {
    const { ws } = policyWorld('studio');
    // Room to spare: cards at their full size.
    const roomy = laid(overviewOf(ws, { width: 1600, height: 900 }).layout);
    expect(roomy.scale).toBe(1);
    expect([roomy.width, roomy.height]).toEqual([CARD.width, CARD.height]);
    // Less room: smaller cards, every window still there.
    const tight = laid(overviewOf(ws, { width: 420, height: 300 }).layout);
    expect(tight.scale).toBeLessThan(1);
    expect(tight.cards).toHaveLength(roomy.cards.length);
    // Two hundred and fifty windows on the usual board: smaller cards still.
    const dense = laid(overviewOf(policyWorld('dense').ws).layout);
    expect(dense.cards).toHaveLength(250);
    expect(dense.scale).toBeLessThan(tight.scale);
    // A board smaller than the smallest card holds none.
    const smallest = Math.min(...CARD_SCALES);
    expect(
      overviewOf(ws, { width: CARD.width * smallest - 1, height: CARD.height * smallest - 1 })
        .layout,
    ).toEqual({ kind: 'crowded' });
  });

  it('reads the scene and holds no layout or state of its own', () => {
    const { ws } = policyWorld('studio');
    const before = overviewOf(ws);
    // The same scene, the same overview: nothing is kept between one reading and the next.
    expect(overviewOf(ws)).toEqual(before);
    const revision = ws.getState().revision;
    const history = ws.history().length;
    // Reading it changes nothing in the scene.
    expect(ws.getState().revision).toBe(revision);
    expect(ws.history()).toHaveLength(history);

    // A window moved in the scene moves its card: the reading list, behind, brought in front.
    const transform = aroundCamera(ws.getState(), 'reading', VIEWPORT, 'front');
    if (transform === null) throw new Error('cannot place the reading list');
    expect(ws.dispatch({ type: 'node.patch', id: 'reading', transform }).status).toBe('committed');
    const moved = overviewOf(ws);
    const was = entry(before.scene.entries, 'reading');
    const now = entry(moved.scene.entries, 'reading');
    expect(was.behind).toBe(true);
    expect(now.behind).toBe(false);
    const cardOf = (o: typeof before, id: string) => laid(o.layout).cards.find((c) => c.id === id);
    expect(cardOf(moved, 'reading')?.x).not.toBe(cardOf(before, 'reading')?.x);
    // Undone, the overview is what it was, card for card.
    ws.undo();
    expect(overviewOf(ws)).toEqual(before);

    // A preview (a drag under way) is shown as it goes, and the scene itself is untouched.
    const preview = aroundCamera(ws.getState(), 'archive', VIEWPORT, 'front');
    if (preview === null) throw new Error('cannot place the archive');
    const settled = ws.getState().revision;
    expect(
      ws.preview('drag', [{ type: 'node.patch', id: 'archive', transform: preview }]).status,
    ).toBe('previewed');
    expect(entry(overviewOf(ws).scene.entries, 'archive').behind).toBe(false);
    expect(ws.getState().revision).toBe(settled);
    ws.cancelPreview('drag', 'escape');
    expect(overviewOf(ws)).toEqual(before);

    // Selection and focus are the scene's: the overview shows them, and has none of its own.
    ws.dispatch({ type: 'selection.set', ids: ['metrics'] });
    expect(entry(overviewOf(ws).scene.entries, 'metrics').selected).toBe(true);
    expect(
      overviewOf(ws)
        .scene.entries.filter((e) => e.selected)
        .map((e) => e.id),
    ).toEqual(['metrics']);
  });
});
