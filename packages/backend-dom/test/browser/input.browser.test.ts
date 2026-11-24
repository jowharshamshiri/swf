import { afterEach, describe, expect, it } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { DEFAULT_CHROME_INKS, DOM_ATTRIBUTES } from '../../src/index.js';
import type { Stage } from './fixture.js';
import { drag, onWindow, pageOf, screenOf, stage, W } from './fixture.js';

let current: Stage | null = null;
afterEach(async () => {
  await current?.dispose();
  current = null;
});

/** A window with a wide frame around its surface: 3 × 2 units, the surface 2 × 1, at 3 units. */
const framed = {
  id: 'a',
  heading: 0,
  distance: 3,
  size: [3, 2] as const,
  inset: 1,
  label: 'Notes',
};

const story = (s: Stage) =>
  s.events.flatMap((e) =>
    e.type === 'gesture.started'
      ? [`start ${e.operation}`]
      : e.type === 'gesture.ended'
        ? [`end ${e.finish.outcome}`]
        : [],
  );

describe('native input stays native (FR-053, FR-110, SEC-014)', () => {
  it('lets content receive the browser’s own, trusted events, with nothing taken by the framework', async () => {
    current = await stage([framed]);
    const live = current.lives.get('key-a');
    if (live === undefined) {
      throw new Error('no live content');
    }
    const before = current.ws.getState().nodes.get('a')?.transform;
    await userEvent.click(live.button);
    expect(live.received.map((r) => r.type)).toEqual(['pointerdown', 'pointerup', 'click']);
    expect(live.received.every((r) => r.trusted)).toBe(true);
    expect(story(current)).toEqual([]);
    expect(current.router.captures()).toEqual([]);
    expect(current.ws.getState().nodes.get('a')?.transform).toBe(before);
  });

  it('lets keys typed into content reach it, even keys the workspace binds', async () => {
    current = await stage([framed]);
    const live = current.lives.get('key-a');
    if (live === undefined) {
      throw new Error('no live content');
    }
    expect(current.ws.dispatch({ type: 'selection.set', ids: ['a'] }).status).toBe('committed');
    const before = current.ws.getState().nodes.get('a')?.transform;
    await userEvent.type(live.input, 'hello');
    // Arrow keys move the selected window, but not while typing in content.
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}x');
    expect(live.input.value).toBe('helxlo');
    expect(current.ws.getState().nodes.get('a')?.transform).toBe(before);
  });

  it('gives content in a cross-origin frame its input from the browser alone', async () => {
    current = await stage([framed]);
    const live = current.lives.get('key-a');
    if (live === undefined) {
      throw new Error('no live content');
    }
    const frame = document.createElement('iframe');
    frame.style.setProperty('width', '100%');
    frame.style.setProperty('height', '100%');
    const loaded = new Promise((resolve) => {
      frame.addEventListener('load', resolve, { once: true });
    });
    frame.src = 'data:text/html,<body style="margin:0;height:100vh">cross-origin</body>';
    live.element.replaceChildren(frame);
    await loaded;
    let reached = 0;
    const count = () => {
      reached += 1;
    };
    document.addEventListener('pointerdown', count, true);
    // The frame's document has another origin: the framework can neither read nor reach it.
    expect(() => frame.contentDocument?.body).not.toThrow();
    expect(frame.contentDocument).toBeNull();
    const box = frame.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y);
    await commands.mouse('up', x, y);
    document.removeEventListener('pointerdown', count, true);
    // The press went into the frame: nothing reached this document, so nothing was routed.
    expect(reached).toBe(0);
    expect(story(current)).toEqual([]);
  });
});

describe('chrome on its own layers (FR-054, FR-089)', () => {
  it('draws frame and title without taking input, and handles that take it', async () => {
    current = await stage([framed]);
    const view = current.views.get('v');
    const chrome = view?.root.querySelector<HTMLElement>(`[${DOM_ATTRIBUTES.layer}="chrome"]`);
    if (view === undefined || chrome === null || chrome === undefined) {
      throw new Error('no chrome');
    }
    expect(getComputedStyle(chrome).pointerEvents).toBe('none');
    const frame = chrome.querySelector<HTMLElement>(`[${DOM_ATTRIBUTES.layer}="chrome-frame"]`);
    expect(getComputedStyle(frame ?? document.body).pointerEvents).toBe('none');
    const handles = [...chrome.querySelectorAll<HTMLElement>(`[${DOM_ATTRIBUTES.handle}]`)];
    expect(handles.map((h) => h.getAttribute(DOM_ATTRIBUTES.handle)).sort()).toEqual(
      ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'].sort(),
    );
    expect(handles.every((h) => getComputedStyle(h).pointerEvents === 'auto')).toBe(true);
    // Over the content, the browser finds the content, not the chrome above it.
    const [cx, cy] = pageOf(view.root, ...screenOf(current, onWindow(current, 'a', [0, 0, 0])));
    const hit = document.elementFromPoint(cx, cy);
    expect(hit?.closest('[data-test-content]')).not.toBeNull();
    expect(hit?.closest(`[${DOM_ATTRIBUTES.layer}="chrome"]`)).toBeNull();
    // The chrome is a layer of its own, not inside the content's.
    expect(chrome.closest(`[${DOM_ATTRIBUTES.layer}="content-native"]`)).toBeNull();
  });

  it('draws the frame, and marks the selected and the focused window, in the host’s inks (WCAG 2.4.7, 1.4.11)', async () => {
    current = await stage([framed], {
      inks: { frame: 'var(--test-frame)', selected: 'rgb(0, 0, 200)', focused: 'rgb(200, 0, 0)' },
    });
    const view = current.views.get('v');
    const container = current.containers.get('v');
    if (view === undefined || container === undefined) {
      throw new Error('no view');
    }
    container.style.setProperty('--test-frame', 'rgb(0, 120, 0)');
    const frame = () => {
      const element = view.root.querySelector<HTMLElement>(
        `[${DOM_ATTRIBUTES.layer}="chrome-frame"]`,
      );
      if (element === null) {
        throw new Error('no frame');
      }
      const style = getComputedStyle(element);
      return {
        colour: style.borderTopColor,
        width: style.borderTopWidth,
        line: style.borderTopStyle,
      };
    };
    expect(frame()).toEqual({ colour: 'rgb(0, 120, 0)', width: '1px', line: 'solid' });
    current.ws.dispatch({ type: 'selection.set', ids: ['a'] });
    await view.update();
    expect(frame()).toEqual({ colour: 'rgb(0, 0, 200)', width: '3px', line: 'solid' });
    current.ws.dispatch({ type: 'focus.set', id: 'a' });
    await view.update();
    expect(frame()).toEqual({ colour: 'rgb(200, 0, 0)', width: '3px', line: 'solid' });
    current.ws.transaction([
      { type: 'selection.set', ids: [] },
      { type: 'focus.set', id: null },
    ]);
    await view.update();
    expect(frame()).toEqual({ colour: 'rgb(0, 120, 0)', width: '1px', line: 'solid' });
  });

  it('draws in inks that stand out on a light page by default', () => {
    expect(DEFAULT_CHROME_INKS).toEqual({
      frame: 'rgb(118, 118, 118)',
      selected: 'rgb(0, 95, 184)',
      focused: 'rgb(168, 74, 0)',
    });
  });

  it('moves a window dragged by its frame, holding the pointer outside the view until release', async () => {
    current = await stage([framed]);
    const view = current.views.get('v');
    if (view === undefined) {
      throw new Error('no view');
    }
    const before = current.ws.getState().nodes.get('a')?.transform.position;
    const start = screenOf(current, onWindow(current, 'a', [0, 0.6, 0]));
    // Between the surface and the resize band: the frame, where the content does not reach.
    const [px, py] = pageOf(view.root, ...start);
    expect(document.elementFromPoint(px, py)?.closest('[data-test-content]')).toBeNull();
    let capturedDuring = false;
    view.root.addEventListener(
      'pointermove',
      (e) => {
        capturedDuring ||= view.root.hasPointerCapture(e.pointerId);
      },
      // In the capture phase, where the input adapter sees it too, before it stops the event.
      { capture: true },
    );
    await drag(view.root, start, [
      [start[0] + 30, start[1]],
      [W + 40, start[1]],
      [start[0] + 60, start[1] + 10],
    ]);
    expect(capturedDuring).toBe(true);
    expect(story(current)).toEqual(['start node.move', 'end committed']);
    expect(current.events.filter((e) => e.type === 'capture.released')).toHaveLength(1);
    expect(current.router.captures()).toEqual([]);
    const after = current.ws.getState().nodes.get('a')?.transform.position;
    expect(after?.[0]).toBeGreaterThan((before?.[0] ?? 0) + 0.1);
  });

  it('releases the pointer when Escape cancels a drag, with the button still down', async () => {
    current = await stage([framed]);
    const view = current.views.get('v');
    if (view === undefined) {
      throw new Error('no view');
    }
    const before = current.ws.getState().nodes.get('a')?.transform;
    const start = screenOf(current, onWindow(current, 'a', [0, 0.6, 0]));
    const [x, y] = pageOf(view.root, ...start);
    let pointerId = -1;
    view.root.addEventListener(
      'pointerdown',
      (e) => {
        pointerId = e.pointerId;
      },
      { capture: true },
    );
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y);
    await commands.mouse('move', x + 30, y);
    expect(view.root.hasPointerCapture(pointerId)).toBe(true);
    view.root.tabIndex = 0;
    view.root.focus();
    await userEvent.keyboard('{Escape}');
    expect(story(current)).toEqual(['start node.move', 'end cancelled']);
    expect(view.root.hasPointerCapture(pointerId)).toBe(false);
    await commands.mouse('up', x + 30, y);
    expect(current.ws.getState().nodes.get('a')?.transform).toBe(before);
  });

  it('lets a proxy stand in front of what lies behind it', async () => {
    current = await stage([framed], { viewports: ['w', 'v'] });
    // `w` holds the live element; `v` shows a proxy.
    const v = current.views.get('v');
    const proxy = v?.root.querySelector<HTMLElement>(`[${DOM_ATTRIBUTES.layer}="proxy"]`);
    if (v === undefined || proxy === null || proxy === undefined) {
      throw new Error('no proxy');
    }
    const box = proxy.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    expect(hit?.closest(`[${DOM_ATTRIBUTES.layer}="proxy"]`)).toBe(proxy);
    expect(getComputedStyle(proxy).pointerEvents).toBe('auto');
  });

  it('resizes a window dragged by a handle, even over its content', async () => {
    current = await stage([{ ...framed, inset: 0 }]);
    const view = current.views.get('v');
    const handle = view?.root.querySelector<HTMLElement>(`[${DOM_ATTRIBUTES.handle}="e"]`);
    if (view === undefined || handle === null || handle === undefined) {
      throw new Error('no handle');
    }
    const box = handle.getBoundingClientRect();
    const root = view.root.getBoundingClientRect();
    const from: [number, number] = [
      box.left + box.width / 2 - root.left,
      box.top + box.height / 2 - root.top,
    ];
    // The handle lies over the content, yet the press is the framework's.
    expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)).toBe(
      handle,
    );
    await drag(view.root, from, [
      [from[0] + 10, from[1]],
      [from[0] + 40, from[1]],
    ]);
    expect(story(current)).toEqual(['start node.resize', 'end committed']);
    expect(current.ws.getState().nodes.get('a')?.bounds[0]).toBeGreaterThan(3.2);
    expect(current.lives.get('key-a')?.received).toEqual([]);
  });

  it('takes a press on content only under the takeover modifier, and then content sees none of it', async () => {
    current = await stage([framed]);
    const view = current.views.get('v');
    const live = current.lives.get('key-a');
    if (view === undefined || live === undefined) {
      throw new Error('no view');
    }
    const at = screenOf(current, onWindow(current, 'a', [0, 0.25, 0]));
    const [x, y] = pageOf(view.root, ...at);
    expect(document.elementFromPoint(x, y)).toBe(live.button);
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y, ['Alt']);
    await commands.mouse('up', x, y);
    // A tap: the window is selected, and the button received nothing, not even the click.
    expect(story(current)).toEqual(['start selection.set', 'end committed']);
    expect(current.ws.getState().selection).toEqual(['a']);
    expect(live.received).toEqual([]);
    // Without the modifier the same press is the content's again.
    await commands.mouse('down', x, y);
    await commands.mouse('up', x, y);
    expect(live.received.map((r) => r.type)).toEqual(['pointerdown', 'pointerup', 'click']);
  });
});
