import '@wsb/uikit/styles/uikit.scss';
import '@wsb/uikit/fonts';
import { installAutomation } from '@wsb/uikit/automation';
import { ROOT_CLASS, setAppearance, setDensity } from '@wsb/uikit/primitives';
import { mount, unmount } from 'svelte';
import { FIELD_OF_VIEW, FOCUS_ID, MAP, OVERVIEW, PANORAMA, VIEWPORT_ID } from '@swf/navigation';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import Host from '../src/Host.svelte';
import { Host as HostState, OPENING_FIELD_OF_VIEW } from '../src/host.svelte.js';

/**
 * The host example as a host page runs it: its own live content presented with the framework's
 * whole navigation experience through the navigation controls' package. What the host made stays
 * its own: the same elements, interactive, with what was typed, ticked and scrolled in them, across
 * every way the view moves, and each control can be turned off or replaced on its own.
 */

interface Visit {
  readonly host: HostState;
  readonly settle: () => Promise<void>;
}

const visits: { host: HostState; page: ReturnType<typeof mount>; root: HTMLElement }[] = [];

afterEach(async () => {
  for (const visit of visits.splice(0)) {
    await visit.host.dispose();
    await unmount(visit.page);
    visit.root.remove();
  }
});

/** Mounts the host page at a size, as its page does, and waits for its navigation. */
async function visit(size = { width: 1280, height: 900 }): Promise<Visit> {
  const html = document.documentElement;
  html.classList.add(ROOT_CLASS);
  setAppearance(html, 'light');
  setDensity(html, 'default');
  const root = document.createElement('div');
  root.style.setProperty('position', 'absolute');
  root.style.setProperty('inset', '0 auto auto 0');
  root.style.setProperty('width', `${String(size.width)}px`);
  root.style.setProperty('height', `${String(size.height)}px`);
  document.body.append(root);
  const host = new HostState(document);
  const page = mount(Host, { target: root, props: { host } });
  visits.push({ host, page, root });
  const driver = installAutomation(root, () => 'host');
  await host.started();
  expect(host.problem).toBeNull();
  const settle = async () => {
    await driver.settled();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await driver.settled();
  };
  await settle();
  return { host, settle };
}

/** A part of the host's content the test reads, or an Error naming what is missing. */
function need<T>(value: T | null, what: string): T {
  if (value === null) {
    throw new Error(`the host's content has no ${what}`);
  }
  return value;
}

/** The element a kit handle marks, or null. */
const handle = (name: string) =>
  document.querySelector<HTMLElement>(`[data-wsb="${name}"], [data-wsb^="${name}#"]`);

/** Runs a navigation command through the controls' model, failing on a refusal. */
async function run(
  host: HostState,
  ...[id, params]: Parameters<HostState['model']['runNavigation']>
): Promise<void> {
  const done = await host.model.runNavigation(id, params);
  expect(done, `${id}: ${JSON.stringify(host.model.refusal)}`).toBe(true);
}

describe('the host page', () => {
  it('presents its own views in the panorama with every navigation control', async () => {
    const { host } = await visit();
    expect(host.model.status?.windows).toBe(6);
    // Each live element the host made is in the view, in a slot the backend gave it.
    for (const key of ['notes', 'tasks', 'run', 'log', 'inbox', 'outbox']) {
      const element = host.views.element(key);
      expect(element.isConnected, key).toBe(true);
      expect(element.closest('[data-swf-slot]'), key).not.toBeNull();
    }
    // The controls: the switcher, the view's controls, the radar, the inspector, the experiments.
    for (const name of [
      'editor.actions.mode',
      'page.view.heading',
      'page.view.fov',
      'page.radar.toggle',
      'page.inspector',
    ]) {
      expect(handle(name), name).not.toBeNull();
    }
  });

  it('keeps its content interactive, and the same elements with their state, across movement, focus, projection, backends and modes', async () => {
    const { host, settle } = await visit();
    const notes = host.views.element('notes') as HTMLTextAreaElement;
    const tasks = host.views.element('tasks');
    const log = host.views.element('log');
    const run1 = host.views.element('run');
    const box = need(tasks.querySelector<HTMLInputElement>('input[type="checkbox"]'), 'a task');
    const go = need(run1.querySelector('button'), 'the run button');
    const said = need(run1.querySelector('output'), 'the run output');

    // Interactive as the page's own: typed in, ticked, pressed and scrolled by real input.
    await userEvent.click(notes);
    await userEvent.keyboard('{End} typed by hand');
    // A task ticked by a press on its words, as a label's press ticks its box.
    await userEvent.click(box.closest('label') ?? box);
    await userEvent.click(go);
    log.scrollTop = 40;
    const typed = notes.value;
    expect(typed).toMatch(/typed by hand$/);
    expect(box.checked).toBe(true);
    expect(said.textContent).toBe('Ran build (1)');
    const scrolled = log.scrollTop;
    expect(scrolled).toBeGreaterThan(0);

    /** What the editor holds now: what was typed, and after the move, the full stop typed too. */
    let expected = typed;
    /** Every element is the one the host made, with what was done in it. */
    const held = (step: string) => {
      for (const [key, element] of [
        ['notes', notes],
        ['tasks', tasks],
        ['log', log],
        ['run', run1],
      ] as const) {
        expect(host.views.element(key), `${step}: ${key}`).toBe(element);
        expect(element.isConnected, `${step}: ${key}`).toBe(true);
        // Never copied: the page holds it once.
        const named = `${element.localName}[aria-label="${element.getAttribute('aria-label') ?? ''}"]`;
        expect(document.querySelectorAll(named).length, `${step}: one ${key}`).toBe(1);
      }
      expect(notes.value, step).toBe(expected);
      expect(box.checked, step).toBe(true);
      expect(said.textContent, step).toBe('Ran build (1)');
      // Scrolled where it was left, wherever it is shown (out of view it is not laid out).
      if (log.getClientRects().length > 0) {
        expect(log.scrollTop, step).toBe(scrolled);
      }
    };

    // Movement in view: the editor keeps the keyboard while its window moves, and typing goes on.
    await userEvent.click(notes);
    await run(host, 'swf.window.place', { id: 'notes', x: -1.6, y: 0.1, z: -2.5 });
    await settle();
    expect(document.activeElement).toBe(notes);
    await userEvent.keyboard('{End}.');
    expected = `${typed}.`;
    expect(notes.value).toBe(expected);
    // Movement out of view and back: the window behind the camera and in front again, the view
    // turned away and back; what lies out of view is shown again as it was left.
    await run(host, 'swf.window.sendBehind', { id: 'notes' });
    await run(host, 'swf.window.bringFront', { id: 'notes' });
    await run(host, 'swf.view.heading', { degrees: -120 });
    await settle();
    await run(host, 'swf.view.heading', { degrees: 0 });
    await settle();
    held('moved');

    // Focus: the window shown readably, then the next, then back out.
    await run(host, 'swf.focus.enter', { id: 'notes' });
    await settle();
    expect(host.model.status?.mode).toBe(FOCUS_ID);
    held('focused');
    await run(host, 'swf.focus.step', { direction: 'right' });
    await run(host, 'swf.focus.exit', {});
    await settle();
    held('out of focus');

    // Projection: the panorama narrowed and widened again.
    await run(host, 'swf.view.fov', { degrees: 150 });
    await settle();
    held('narrowed');
    await run(host, 'swf.view.fov', { degrees: FIELD_OF_VIEW.max });
    await settle();
    held('widened');

    // Backends: handed to the DOM backend and back to the geometry one.
    await run(host, 'swf.backend.switch', { backend: 'dom' });
    await settle();
    expect(host.model.status?.backend).toBe('dom');
    held('on the DOM backend');
    await run(host, 'swf.backend.switch', { backend: 'geometry' });
    await settle();
    expect(host.model.status?.backend).toBe('geometry');
    held('on the geometry backend');

    // Modes: the map, the overview, and the panorama again.
    for (const mode of [MAP.id, OVERVIEW.id, PANORAMA.id]) {
      await run(host, 'swf.mode.switch', { mode });
      await settle();
      expect(host.model.status?.mode).toBe(mode);
      held(`in ${mode}`);
    }

    // Back in the panorama the log is shown again, scrolled where it was left.
    expect(log.getClientRects().length).toBeGreaterThan(0);
    expect(log.scrollTop).toBe(scrolled);

    // Still the page's own: at the width it opened with, it takes input as it did at first.
    await run(host, 'swf.view.fov', { degrees: OPENING_FIELD_OF_VIEW });
    await settle();
    await userEvent.click(go);
    expect(said.textContent).toBe('Ran build (2)');
    await userEvent.click(notes);
    await userEvent.keyboard('{End}!');
    expect(notes.value).toBe(`${expected}!`);
  });

  it('turns each control off on its own, the rest working on', async () => {
    const { host, settle } = await visit();
    const shownBy = {
      switcher: 'editor.actions.mode',
      radar: 'page.radar.toggle',
      inspector: 'page.inspector',
    } as const;
    for (const [key, name] of Object.entries(shownBy) as [keyof typeof shownBy, string][]) {
      host.components = { ...host.components, [key]: false };
      await settle();
      expect(handle(name), `${key} off`).toBeNull();
      for (const [other, otherName] of Object.entries(shownBy)) {
        if (other !== key) {
          expect(handle(otherName), `${other} stays while ${key} is off`).not.toBeNull();
        }
      }
      // Navigation goes on: a window revealed, and selected, with the control gone.
      await run(host, 'swf.window.reveal', { id: 'run' });
      expect(host.model.selected?.id).toBe('run');
      host.components = { ...host.components, [key]: true };
      await settle();
      expect(handle(name), `${key} on again`).not.toBeNull();
    }

    // The view's controls off: none across the panorama, and the view still turns.
    host.components = { ...host.components, controls: 'none' };
    await settle();
    expect(handle('page.view.heading')).toBeNull();
    await run(host, 'swf.view.heading', { degrees: 30 });

    // The strip, the map and the overview off: their modes show the panorama whole.
    host.components = {
      ...host.components,
      controls: 'package',
      strip: false,
      map: false,
      overview: false,
    };
    await settle();
    await run(host, 'swf.focus.enter', { id: 'tasks' });
    await settle();
    expect(handle('page.focus.strip')).toBeNull();
    await run(host, 'swf.focus.exit', {});
    await run(host, 'swf.mode.switch', { mode: MAP.id });
    await settle();
    expect(handle('page.map.zoom-in')).toBeNull();
    await run(host, 'swf.mode.switch', { mode: OVERVIEW.id });
    await settle();
    expect(handle('page.overview.board')).toBeNull();

    // Each on: its control is shown in its mode.
    host.components = { ...host.components, strip: true, map: true, overview: true };
    await settle();
    expect(handle('page.overview.board')).not.toBeNull();
    await run(host, 'swf.mode.switch', { mode: MAP.id });
    await settle();
    expect(handle('page.map.zoom-in')).not.toBeNull();
    await run(host, 'swf.mode.switch', { mode: PANORAMA.id });
    await run(host, 'swf.focus.enter', { id: 'tasks' });
    await settle();
    expect(handle('page.focus.strip')).not.toBeNull();
  });

  it('puts its own view controls in the package’s place, driving the same view', async () => {
    const { host, settle } = await visit();
    host.components = { ...host.components, controls: 'own' };
    await settle();
    expect(handle('page.view.heading')).toBeNull();
    const heading = handle('page.host-view.heading');
    expect(heading).not.toBeNull();
    const navigation = host.navigation;
    if (navigation === null || heading === null) {
      throw new Error('the host did not start');
    }
    const facing = () =>
      navigation.workspace
        .getState()
        .cameras.get(navigation.workspace.getState().viewports.get(VIEWPORT_ID)?.cameraId ?? '')
        ?.rotation;
    const before = facing();
    const thumb = heading.querySelector<HTMLElement>('[role="slider"]') ?? heading;
    await userEvent.click(thumb);
    await userEvent.keyboard('{PageUp}');
    await settle();
    expect(facing()).not.toEqual(before);
  });
});
