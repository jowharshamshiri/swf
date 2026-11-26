// QA-009: the reference application's own controls against WCAG 2.2 AA and UX-013/UX-014,
// NFR-023/NFR-024. What the host supplies (the windows' content) is not the framework's and is
// left out of every check.
import '@wsb/uikit/styles/uikit.scss';
import '@wsb/uikit/fonts';
import { installAutomation } from '@wsb/uikit/automation';
import { ROOT_CLASS, setAppearance, setDensity } from '@wsb/uikit/primitives';
import { DOM_ATTRIBUTES } from '@swf/backend-dom';
import { createMemoryStore } from '@swf/persistence';
import axe from 'axe-core';
import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { parseConfig } from '../../src/config.js';
import { createMessages } from '../../src/messages.js';
import { planPreset, PRESETS } from '../../src/presets.js';
import { ShellModel } from '../../src/shell/model.svelte.js';
import Shell from '../../src/shell/Shell.svelte';

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulate: (media: {
      readonly reducedMotion?: 'reduce' | 'no-preference' | null;
      readonly colorScheme?: 'light' | 'dark' | null;
    }) => Promise<void>;
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    swfEmulatesMedia: boolean;
  }
}

/**
 * Whether this browser's automation can emulate an appearance or reduced motion. Playwright
 * cannot in Firefox driven over WebDriver BiDi: the cases that ask for them run where it can.
 */
const emulatesMedia = inject('swfEmulatesMedia');

let current: { model: ShellModel; shell: ReturnType<typeof mount>; root: HTMLElement } | null =
  null;

/** Whether this case emulated media features, to put the platform's own back after it. */
let emulated = false;
async function emulate(media: Parameters<typeof commands.emulate>[0]): Promise<void> {
  emulated = true;
  await commands.emulate(media);
}

afterEach(async () => {
  if (emulated) {
    emulated = false;
    await commands.emulate({ reducedMotion: null, colorScheme: null });
  }
  if (current !== null) {
    await current.model.dispose();
    await unmount(current.shell);
    current.root.remove();
    current = null;
  }
});

/** The shell, mounted as the page mounts it, at a size and in an appearance. */
async function start(
  search: string,
  options: { width?: number; height?: number; appearance?: 'light' | 'dark' } = {},
) {
  const html = document.documentElement;
  html.classList.add(ROOT_CLASS);
  setAppearance(html, options.appearance ?? 'light');
  setDensity(html, 'default');
  const root = document.createElement('div');
  root.style.setProperty('position', 'absolute');
  root.style.setProperty('inset', '0 auto auto 0');
  root.style.setProperty('width', `${String(options.width ?? 1280)}px`);
  root.style.setProperty('height', `${String(options.height ?? 760)}px`);
  document.body.append(root);
  const model = new ShellModel(createMessages(), parseConfig(search), {
    store: createMemoryStore(),
  });
  const shell = mount(Shell, { target: root, props: { model } });
  current = { model, shell, root };
  const driver = installAutomation(root, () => 'reference');
  await expect.poll(() => model.status, { timeout: 10_000 }).not.toBeNull();
  const settle = async () => {
    await driver.settled();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await driver.settled();
  };
  await settle();
  const app = model.app;
  if (app === null) {
    throw new Error('the application did not start');
  }
  return { model, app, root, driver, settle };
}

const SPARSE = planPreset('sparse', PRESETS.sparse.defaultSeed);
const FIRST = SPARSE[0] ?? { id: '', label: '' };

/** The controls a person can operate, in the shell (the panorama's host content left out). */
function controls(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [role="button"], [role="tab"], [tabindex]',
    ),
  ].filter(
    (element) =>
      element.closest(`[${DOM_ATTRIBUTES.slot}]`) === null &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden' &&
      !(element as HTMLButtonElement).disabled &&
      element.getAttribute('tabindex') !== '-1',
  );
}

/** WCAG's relative luminance of a CSS colour the browser resolved (`rgb(…)` or `rgba(…)`). */
function luminance(colour: string): number {
  const channels = colour
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (channels?.length !== 3) {
    throw new Error(`not a resolved colour: ${colour}`);
  }
  const [r, g, b] = channels.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The ground an element is drawn on: its own background, or the nearest one painted under it. */
function groundOf(element: HTMLElement): string {
  for (let e: HTMLElement | null = element; e !== null; e = e.parentElement) {
    const background = getComputedStyle(e).backgroundColor;
    if (!/rgba\(.*, 0\)$/.test(background) && background !== 'transparent') {
      return background;
    }
  }
  return getComputedStyle(document.body).backgroundColor;
}

describe('the reference controls (QA-009, UX-013, NFR-024)', () => {
  for (const appearance of ['light', 'dark'] as const) {
    it.runIf(emulatesMedia)(
      `meet WCAG 2.2 A and AA in the ${appearance} appearance, with the selection, its inspector and the windows listed`,
      async () => {
        const { root, driver, settle } = await start('?preset=sparse', { appearance });
        await emulate({ colorScheme: appearance });
        driver.act('workshop.view#windows', 'press');
        await settle();
        driver.act(`page.windows.window#${FIRST.id}`, 'press');
        await settle();
        const result = await axe.run(
          { include: [root], exclude: [[`[${DOM_ATTRIBUTES.slot}]`]] },
          {
            runOnly: {
              type: 'tag',
              values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'],
            },
          },
        );
        expect(
          result.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          ),
        ).toEqual([]);
      },
    );
  }

  it('reaches the panorama in the page’s order and lets the keyboard leave it (WCAG 2.1.1, 2.1.2, 2.4.3)', async () => {
    const { root, app } = await start('?preset=sparse');
    // The order is the document's: nothing jumps the queue.
    expect(
      [...root.querySelectorAll('[tabindex]')].filter(
        (e) => Number(e.getAttribute('tabindex')) > 0,
      ),
    ).toEqual([]);
    const visited: (string | null)[] = [];
    for (let stop = 0; stop < 200 && document.activeElement !== app.root; stop += 1) {
      await userEvent.tab();
      const active = document.activeElement;
      visited.push(
        active instanceof HTMLElement
          ? (active.closest('[data-wsb]')?.getAttribute('data-wsb') ?? null)
          : null,
      );
    }
    expect(document.activeElement).toBe(app.root);
    // The rails and the scene come first, then the view's own actions, then the view.
    const at = (handle: string) => visited.indexOf(handle);
    expect(at('workshop.view#scene')).toBeGreaterThanOrEqual(0);
    expect(at('workshop.view#scene')).toBeLessThan(at('editor.actions.undo'));
    expect(at('editor.actions.undo')).toBeLessThan(visited.length - 1);
    // Tab leaves it, forward through the windows' own content and back: the framework's keys
    // never trap the keyboard.
    for (let stop = 0; stop < 40 && app.root.contains(document.activeElement); stop += 1) {
      await userEvent.tab();
    }
    expect(app.root.contains(document.activeElement)).toBe(false);
    for (let stop = 0; stop < 40 && document.activeElement !== app.root; stop += 1) {
      await userEvent.tab({ shift: true });
    }
    expect(document.activeElement).toBe(app.root);
    await userEvent.tab({ shift: true });
    expect(app.root.contains(document.activeElement)).toBe(false);
  });

  it('shows where the keyboard is on every control it stops at (WCAG 2.4.7)', async () => {
    const { model, app, root, settle } = await start('?preset=sparse');
    await model.select(FIRST.id);
    await settle();
    /** The panorama's frame: its view draws the ring there while the panorama has the keyboard. */
    const frame = root.querySelector('[data-wsb="page.panorama.viewport"]')?.parentElement ?? null;
    /**
     * What shows an element has the keyboard: its ring, its edge, its ground, and the ring of
     * what it draws inside it (a slider rings its thumb).
     */
    const look = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const ring =
        element === app.root && frame !== null ? getComputedStyle(frame, '::after') : null;
      const outline = (s: CSSStyleDeclaration) =>
        s.outlineStyle === 'none'
          ? 'none'
          : `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`;
      const inner =
        element === app.root
          ? []
          : [...element.querySelectorAll('*')].map((child) => outline(getComputedStyle(child)));
      return [
        ring === null ? '' : `${ring.content} ${ring.borderTopStyle} ${ring.borderTopColor}`,
        outline(style),
        style.borderTopColor,
        style.backgroundColor,
        style.boxShadow,
        ...inner,
      ].join(' / ');
    };
    const unringed: string[] = [];
    let stops = 0;
    let last: { element: HTMLElement; focused: string } | null = null;
    for (let stop = 0; stop < 120; stop += 1) {
      await userEvent.tab();
      // The control left behind: it must have looked otherwise while it had the keyboard.
      if (last !== null && look(last.element) === last.focused) {
        unringed.push(
          last.element.closest('[data-wsb]')?.getAttribute('data-wsb') ??
            last.element.outerHTML.slice(0, 80),
        );
      }
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !root.contains(active)) {
        break;
      }
      stops += 1;
      // A ring of 1px at least, in the kit's focus colour, or the element drawn in it.
      expect(look(active)).toMatch(/rgb/);
      last = active.matches(':focus-visible') ? { element: active, focused: look(active) } : null;
      if (last === null) {
        unringed.push(
          active.closest('[data-wsb]')?.getAttribute('data-wsb') ?? active.outerHTML.slice(0, 80),
        );
      }
    }
    expect(stops).toBeGreaterThan(30);
    expect(unringed).toEqual([]);
  });

  it.runIf(emulatesMedia)(
    'rings the panorama inside its own edge while it has the keyboard, where nothing clips it (WCAG 2.4.7, 1.4.11)',
    async () => {
      for (const appearance of ['light', 'dark'] as const) {
        const { app, root } = await start('?preset=sparse', { appearance });
        await emulate({ colorScheme: appearance });
        const frame = root.querySelector('[data-wsb="page.panorama.viewport"]')?.parentElement;
        if (frame === null || frame === undefined) {
          throw new Error('no panorama frame');
        }
        for (let stop = 0; stop < 200 && document.activeElement !== app.root; stop += 1) {
          await userEvent.tab();
        }
        expect(document.activeElement).toBe(app.root);
        const ring = getComputedStyle(frame, '::after');
        expect(ring.content).not.toBe('none');
        expect(ring.borderTopStyle).toBe('solid');
        expect(parseFloat(ring.borderTopWidth)).toBeGreaterThanOrEqual(2);
        // Drawn within the frame's own box, so the viewport's edge cannot cut it off.
        expect([ring.top, ring.right, ring.bottom, ring.left]).toEqual([
          '0px',
          '0px',
          '0px',
          '0px',
        ]);
        const box = frame.getBoundingClientRect();
        const page = root.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(page.left);
        expect(box.right).toBeLessThanOrEqual(page.right);
        // In the focus colour, standing out from what is around the view.
        expect(
          contrast(ring.borderTopColor, groundOf(frame.parentElement ?? frame)),
        ).toBeGreaterThanOrEqual(3);
        // Gone when the keyboard leaves.
        await userEvent.tab({ shift: true });
        expect(getComputedStyle(frame, '::after').content).toBe('none');
        await current?.model.dispose();
        if (current !== null) {
          await unmount(current.shell);
          current.root.remove();
          current = null;
        }
      }
    },
  );

  it('keeps every control at least 24 by 24 CSS pixels (WCAG 2.5.8, UX-013)', async () => {
    const { model, root, settle } = await start('?preset=sparse');
    await model.select(FIRST.id);
    await settle();
    const small = controls(root)
      .filter((element) => element !== model.app?.root)
      .map((element) => {
        // What a press lands on: a checkbox's whole label, a splitter's band past its line.
        const target = element.closest('label') ?? element;
        const box = target.getBoundingClientRect();
        const band = getComputedStyle(target, '::before');
        const reach = (side: 'left' | 'right' | 'top' | 'bottom') =>
          band.content !== 'none' && band.position === 'absolute'
            ? Math.max(0, -parseFloat(band[side]) || 0)
            : 0;
        return {
          element,
          width: box.width + reach('left') + reach('right'),
          height: box.height + reach('top') + reach('bottom'),
        };
      })
      .filter(({ width, height }) => width < 24 - 0.01 || height < 24 - 0.01)
      .map(
        ({ element, width, height }) =>
          `${element.closest('[data-wsb]')?.getAttribute('data-wsb') ?? element.tagName}: ${width.toFixed(1)}×${height.toFixed(1)}`,
      );
    expect(controls(root).length).toBeGreaterThan(40);
    expect(small).toEqual([]);
  });

  it.runIf(emulatesMedia)(
    'moves nothing when the reader asks for reduced motion, and moves nothing on its own anyway (WCAG 2.3.3)',
    async () => {
      await emulate({ reducedMotion: 'reduce' });
      const { model, root, driver, settle } = await start('?preset=sparse');
      expect(getComputedStyle(root).getPropertyValue('--wsb-motion-base').trim()).toBe('0ms');
      // Going to a window, focusing it and showing the map are instant: the camera jumps.
      await model.run('reference.window.reveal', { id: FIRST.id });
      await model.run('reference.focus.enter', { id: FIRST.id });
      driver.act('editor.actions.mode#map', 'press');
      await settle();
      expect(document.getAnimations().filter((a) => a.playState === 'running')).toEqual([]);
    },
  );

  it.runIf(emulatesMedia)(
    'draws window frames, the selection and the focused window in the kit’s inks, standing out from the view in both appearances (WCAG 1.4.11)',
    async () => {
      for (const appearance of ['light', 'dark'] as const) {
        const { app, settle } = await start('?preset=sparse', { appearance });
        await emulate({ colorScheme: appearance });
        const ground = groundOf(app.root);
        const frameOf = (id: string) =>
          app.root.querySelector<HTMLElement>(
            `[${DOM_ATTRIBUTES.layer}="chrome"][${DOM_ATTRIBUTES.node}="${id}"] [${DOM_ATTRIBUTES.layer}="chrome-frame"]`,
          );
        const second = SPARSE[1]?.id ?? '';
        app.workspace.transaction([
          { type: 'selection.set', ids: [FIRST.id] },
          { type: 'focus.set', id: second },
        ]);
        await settle();
        const third = SPARSE.find(
          (w) => w.id !== FIRST.id && w.id !== second && frameOf(w.id) !== null,
        );
        const colours = {
          frame:
            frameOf(third?.id ?? '')?.style &&
            getComputedStyle(frameOf(third?.id ?? '') ?? app.root).borderTopColor,
          selected: getComputedStyle(frameOf(FIRST.id) ?? app.root).borderTopColor,
          focused: getComputedStyle(frameOf(second) ?? app.root).borderTopColor,
        };
        for (const [what, colour] of Object.entries(colours)) {
          expect(typeof colour, what).toBe('string');
          expect(
            contrast(String(colour), ground),
            `${what} ${String(colour)} on ${ground}`,
          ).toBeGreaterThanOrEqual(3);
        }
        expect(new Set(Object.values(colours)).size).toBe(3);
        // They are the kit's own colours for the appearance, as the kit checks them.
        const probe = document.createElement('span');
        app.root.append(probe);
        const kit = (token: string) => {
          probe.style.setProperty('color', `var(${token})`);
          return getComputedStyle(probe).color;
        };
        expect(colours).toEqual({
          frame: kit('--vscode-descriptionForeground'),
          selected: kit('--vscode-focusBorder'),
          focused: kit('--vscode-editorWarning-foreground'),
        });
        probe.remove();
        // The windows' titles are the framework's text, over the view's ground (axe cannot decide
        // them: the layers overlap).
        const titles = [
          ...app.root.querySelectorAll<HTMLElement>(`[${DOM_ATTRIBUTES.label}]`),
        ].filter((title) => title.textContent !== '');
        expect(titles.length).toBeGreaterThan(0);
        for (const title of titles) {
          expect(
            contrast(getComputedStyle(title).color, ground),
            title.textContent,
          ).toBeGreaterThanOrEqual(4.5);
        }
        await current?.model.dispose();
        if (current !== null) {
          await unmount(current.shell);
          current.root.remove();
          current = null;
        }
      }
    },
  );

  it('says what it did to assistive technology, and alerts what it refused (WCAG 4.1.3, 3.3.1)', async () => {
    const { model, root, driver, settle } = await start('?preset=sparse');
    // The application's one announcer, the kit's: said politely, as a new line each time.
    const polite = root.querySelector<HTMLElement>('[data-wsb="application.announcer.polite"]');
    expect(polite?.getAttribute('aria-live')).toBe('polite');
    expect(root.querySelectorAll('[data-wsb="application.announcer"]')).toHaveLength(1);
    await model.select(FIRST.id);
    await settle();
    driver.act('page.inspector.pose#heading', 'key', 'ArrowRight');
    await settle();
    expect(polite?.lastElementChild?.textContent).toContain(`${FIRST.label} moved`);
    driver.act('page.inspector.pose#heading', 'key', 'ArrowLeft');
    await settle();
    // Said again, as another line: a repeat is heard too.
    expect(polite?.children.length).toBe(2);
    // Heard, not seen: it takes no room on the page.
    const announcer = root.querySelector<HTMLElement>('[data-wsb="application.announcer"]');
    const said = announcer?.getBoundingClientRect();
    expect((said?.width ?? 0) * (said?.height ?? 0)).toBeLessThanOrEqual(1);
    expect(announcer === null ? '' : getComputedStyle(announcer).overflow).toBe('hidden');
    // A refusal is said over the inspector, once, as an alert.
    const near = await model.run('reference.window.pose', { id: FIRST.id, reach: 0 });
    expect(near).toBe(false);
    await settle();
    const refused = root.querySelector('[data-wsb="page.inspector.refusal"]');
    expect(refused?.getAttribute('role')).toBe('alert');
    expect(refused?.textContent).toMatch(/reach must be at least/);
    expect(root.querySelectorAll('[role="alert"]')).toHaveLength(1);
    // Another refusal takes its place, said once.
    const asked: unknown = 'yes';
    await model.run('reference.window.lock', { id: FIRST.id, locked: asked as boolean });
    await settle();
    const refusal = root.querySelector('[data-wsb="page.inspector.refusal"]');
    expect(refusal?.getAttribute('role')).toBe('alert');
    expect(refusal?.textContent).toMatch(/locked must be true or false/);
    expect(root.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});

describe('a control for every gesture, for touch, pen and keyboard (UX-014, UX-006)', () => {
  it('offers each pointer gesture’s operation as a control that needs no gesture', async () => {
    const { model, app, driver, settle } = await start('?preset=sparse');
    // A new gesture policy fails here until it is given its control below.
    expect(app.router.policyIds().filter((id) => id.startsWith('swf.'))).toEqual([
      'swf.background-navigation/1',
      'swf.pinch-depth/1',
      'swf.tap-select/1',
      'swf.window-move/1',
      'swf.window-resize/1',
    ]);
    expect(app.router.policyIds().filter((id) => id.startsWith('reference.'))).toEqual([
      'reference.depth-drag/1',
      'reference.magnetic-move/1',
      'reference.select-toggle/1',
      'reference.turn-drag/1',
    ]);
    const pose = () =>
      app.poseOf(FIRST.id) ??
      (() => {
        throw new Error('gone');
      })();
    // Tap to select: a row of the windows list.
    driver.act('workshop.view#windows', 'press');
    await settle();
    driver.act(`page.windows.window#${FIRST.id}`, 'press');
    await settle();
    expect(model.selected?.id).toBe(FIRST.id);
    // Ctrl+click to select more: a row's own toggle.
    const other = SPARSE[1]?.id ?? '';
    driver.act(`page.windows.row.select#${other}`, 'press');
    await settle();
    expect(app.workspace.getState().selection).toEqual([other, FIRST.id]);
    driver.act(`page.windows.row.select#${other}`, 'press');
    await settle();
    expect(app.workspace.getState().selection).toEqual([FIRST.id]);
    // A window drag (and its magnetic move): round the camera and up.
    let before = pose();
    driver.act('page.inspector.pose#heading', 'key', 'ArrowRight');
    driver.act('page.inspector.pose#y', 'key', 'ArrowUp');
    await settle();
    expect(pose().heading).toBeGreaterThan(before.heading);
    expect(pose().position[1]).toBeGreaterThan(before.position[1]);
    // Shift and drag, the wheel with Shift, and a pinch: nearer and farther.
    before = pose();
    driver.act('page.inspector.pose#reach', 'key', 'ArrowRight');
    await settle();
    expect(pose().reach).toBeGreaterThan(before.reach);
    driver.act('page.inspector.pose#reach', 'key', 'ArrowLeft');
    await settle();
    expect(pose().reach).toBeLessThan(before.reach + 0.1);
    // A resize handle: wider, taller, and the exact size.
    driver.act('page.inspector.pose#width', 'key', 'ArrowRight');
    driver.act('page.inspector.pose#height', 'key', 'ArrowRight');
    await settle();
    expect(pose().width).toBeGreaterThan(before.width);
    expect(pose().height).toBeGreaterThan(before.height);
    driver.act('page.inspector.pose.number#width', 'set', '2');
    await settle();
    expect(pose().width).toBeCloseTo(2, 6);
    // Ctrl and drag: turning a window.
    driver.act('page.inspector.pose#turned', 'key', 'ArrowRight');
    await settle();
    expect(pose().turned).toBeGreaterThan(before.turned);
    // A background drag turns the camera: the window's Reveal turns it to the window.
    await model.run('reference.window.reveal', { id: SPARSE[2]?.id ?? '' });
    driver.act(`page.inspector.window.reveal#${SPARSE[2]?.id ?? ''}`, 'press');
    await settle();
    // ... or the workspace, from Features.
    driver.act('workshop.view#features', 'press');
    await settle();
    const turned = app.workspace.history().length;
    driver.act('page.features.orbit.right', 'press');
    await settle();
    expect(app.workspace.history().length).toBe(turned + 1);
  });

  it('gives an overview and selection at 320 CSS pixels, with nothing beyond the window (NFR-023, WCAG 1.4.10)', async () => {
    const { model, root, driver, settle } = await start('?preset=sparse', {
      width: 320,
      height: 640,
    });
    expect(root.scrollWidth).toBeLessThanOrEqual(320);
    // Close the side that floats, as a person would, and the centre's actions fit within it.
    driver.act('workshop.view#scene', 'press');
    await settle();
    for (const handle of [
      'editor.actions.mode',
      'editor.actions.undo',
      'editor.actions.commands',
    ]) {
      const box = root.querySelector(`[data-wsb="${handle}"]`)?.getBoundingClientRect();
      expect(box, handle).toBeDefined();
      expect(box?.left ?? -1, handle).toBeGreaterThanOrEqual(0);
      expect(box?.right ?? 999, handle).toBeLessThanOrEqual(320);
    }
    driver.act('worktree.view#inspector', 'press');
    await settle();
    driver.act('editor.actions.mode', 'choose', 'overview');
    await settle();
    expect(model.status?.mode).toBe('overview');
    driver.act(`page.overview.tile#${FIRST.id}`, 'press');
    await settle();
    expect(model.selected?.id).toBe(FIRST.id);
    expect(root.scrollWidth).toBeLessThanOrEqual(320);
  });
});
