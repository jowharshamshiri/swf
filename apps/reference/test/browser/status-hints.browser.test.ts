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

/**
 * Every item of the status bar whose words are cut: shown narrower than they are, or reaching past
 * the page's edge.
 */
function cut(root: HTMLElement): string[] {
  const edge = root.getBoundingClientRect();
  return [...root.querySelectorAll<HTMLElement>('.wsb-status-item__label')]
    .filter((label) => {
      const box = label.getBoundingClientRect();
      return (
        label.scrollWidth > label.clientWidth || box.left < edge.left || box.right > edge.right
      );
    })
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
        size,
      );
      const app = m.model.app;
      if (app === null) throw new Error('no application');
      // Beside it: drags that turn the workspace, and a change not saved yet.
      await m.model.run('reference.navigation.set', { target: 'orbit' });
      await m.model.run('reference.window.sendBehind', { id: 'desk' });
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
      await m.model.run('reference.focus.enter', { id: 'builds' });
      await m.settle();
      whole(m, HINTS.focus, ENGLISH['focus.hint.short']);
      // Each says the whole of itself when asked (its title).
      expect(m.root.querySelector(`[data-wsb="${HINTS.focus}"]`)?.getAttribute('title')).toBe(
        ENGLISH['focus.hint'],
      );
    });
  }
});
