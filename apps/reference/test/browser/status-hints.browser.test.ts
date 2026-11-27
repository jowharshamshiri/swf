import { makeError, SwfFailure } from '@swf/core';
import type { SnapshotStore } from '@swf/persistence';
import { createMemoryStore } from '@swf/persistence';
import { describe, expect, it } from 'vitest';
import { ENGLISH } from '../../src/messages.js';
import type { Mounted as Visit } from './shell-harness.js';
import { start } from './shell-harness.js';

/** The hints the status bar shows, one at a time, by what has the reader's attention. */
const HINTS = Object.freeze({
  takeover: 'application.panel.takeover',
  keys: 'application.panel.keys',
  focus: 'application.panel.focus',
});

/** How wide a part of an element is shown: its box, within every ancestor that clips it. */
function shownWidth(element: HTMLElement): number {
  const box = element.getBoundingClientRect();
  let [left, right] = [box.left, box.right];
  for (let a = element.parentElement; a !== null; a = a.parentElement) {
    if (getComputedStyle(a).overflowX !== 'visible' || a === document.documentElement) {
      const clip = a.getBoundingClientRect();
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
  }
  return Math.max(0, right - left);
}

/**
 * Every item of the status bar, and its tab, whose words are cut: shown narrower than they are,
 * whether by their own box or by a box around them.
 */
function cut(root: HTMLElement): string[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      '.wsb-status-item__label, [data-wsb="application.panel.tabs"] .wsb-tabs__label',
    ),
  ]
    .filter((label) => shownWidth(label) + 0.5 < label.scrollWidth)
    .map((label) => label.closest('[data-wsb]')?.getAttribute('data-wsb') ?? label.textContent);
}

/** The hint on show, and that nothing in the status bar is cut. */
function whole(m: Visit, hint: string, words: string): void {
  const item = m.root.querySelector<HTMLElement>(`[data-wsb="${hint}"]`);
  expect(item, hint).not.toBeNull();
  expect(item?.textContent).toContain(words);
  expect(cut(m.root), hint).toEqual([]);
}

describe('the status bar’s hints', () => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1600, height: 1000 },
  ]) {
    it(`shows every hint whole at ${String(size.width)} × ${String(size.height)}, beside the longest of its neighbours`, async () => {
      const m = await start(
        '?preset=studio',
        { store: createMemoryStore(), autosaveDelayMs: 60_000 },
        { size },
      );
      const app = m.model.app;
      if (app === null) throw new Error('no application');
      // Beside it: drags that turn the workspace, and a change not saved yet.
      await m.model.run('swf.navigation.set', { target: 'orbit' });
      await m.model.run('swf.window.sendBehind', { id: 'desk' });
      await m.settle();
      expect(m.root.textContent).toContain(ENGLISH['navigation.status.orbit']);
      expect(m.root.textContent).toContain(ENGLISH['save.dirty']);
      whole(m, HINTS.takeover, ENGLISH['view.takeover.short']);
      // The panorama has the keyboard: its keys.
      app.root.focus();
      await m.settle();
      whole(m, HINTS.keys, ENGLISH['panorama.keys.short']);
      // In focus: how to move it.
      app.root.blur();
      await m.model.run('swf.focus.enter', { id: 'builds' });
      await m.settle();
      whole(m, HINTS.focus, ENGLISH['focus.hint.short']);
      // Each says the whole of itself when asked (its title).
      expect(m.root.querySelector(`[data-wsb="${HINTS.focus}"]`)?.getAttribute('title')).toBe(
        ENGLISH['focus.hint'],
      );
    });

    it(`says a save failed in short at ${String(size.width)} × ${String(size.height)}, its reason when asked, and cuts nothing beside it`, async () => {
      const memory = createMemoryStore();
      const store: SnapshotStore = {
        guarantees: memory.guarantees,
        load: (key) => memory.load(key),
        list: () => memory.list(),
        delete: (key) => memory.delete(key),
        // A full storage, as the browser's own store says it.
        save: () =>
          Promise.reject(
            new SwfFailure(
              makeError('QUOTA_EXCEEDED', 'saving "space/Studio" failed: the storage is full'),
            ),
          ),
      };
      const m = await start('?preset=studio', { store, autosaveDelayMs: 0 }, { size });
      await m.model.run('swf.navigation.set', { target: 'orbit' });
      await m.model.run('swf.window.sendBehind', { id: 'desk' });
      await expect.poll(() => m.model.workspaces?.save, { timeout: 10_000 }).toBe('failed');
      await m.settle();
      expect(cut(m.root)).toEqual([]);
      const save = m.root.querySelector('[data-wsb="application.panel.save"]');
      expect(save?.textContent.trim()).toBe(ENGLISH['save.failed.short']);
      expect(save?.getAttribute('title')).toContain('the storage is full');
    });
  }
});
