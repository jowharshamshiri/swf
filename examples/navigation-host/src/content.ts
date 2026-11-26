import type { JsonValue, NodeRecord, SceneCommand } from '@swf/core';
import type { WindowTraits } from '@swf/navigation';
import { CAMERA_ID, layoutSurfaces } from '@swf/navigation';
import type { ContentPreview, HostContent } from '@swf/navigation-ui';
import { cameraRotation } from '@swf/projections';
import type { SurfaceAdapter, SurfaceCapabilities } from '@swf/surfaces';
import { ADAPTER_API_VERSION } from '@swf/surfaces';

/**
 * THE HOST'S OWN CONTENT. A workbench's views as a host would have them: a notes editor, a task
 * list, a run form, a session log that grows by itself, a window holding an inbox and an outbox,
 * and a clock drawn on a canvas. Every element is made once, kept by the host and handed to the
 * framework through the host's own adapters: the framework places it, never makes, copies or reads
 * it, so what is typed, ticked, scrolled or running in it stays as the view moves, focuses, changes
 * projection or mode, and hands over between backends.
 */

/** The host's element adapter: a binding key names one of its live elements. */
export const ELEMENT_ADAPTER = 'host.element/1';
/** The host's drawing adapter: a binding key names one of its canvases. */
export const CANVAS_ADAPTER = 'host.canvas/1';
/** The metadata key under which a window keeps what kind of view it is. */
export const KIND_KEY = 'host.kind';
/** The metadata key under which a window made from another's surface keeps that window's ID. */
export const PART_OF_KEY = 'host.partOf';

/** The kinds of view the host has, in its words. */
export const KINDS = Object.freeze({
  notes: 'Notes editor',
  tasks: 'Task list',
  run: 'Run form',
  log: 'Session log',
  mail: 'Mail',
  clock: 'Clock',
});

/** A kind of view the host has. */
export type Kind = keyof typeof KINDS;

const ELEMENT_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  attachStrategy: 'native-dom',
  nativeInteraction: 'full',
  uvAddressing: true,
  transformFidelity: 'approximate',
  transparency: false,
  clipping: true,
  cursorMapping: true,
  resize: 'intrinsic',
  viewportSharing: 'single-owner',
  safeDetach: true,
  rebinding: true,
  placeholder: false,
  snapshotHooks: false,
});

const CANVAS_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  attachStrategy: 'drawable',
  nativeInteraction: 'none',
  uvAddressing: true,
  transformFidelity: 'exact',
  transparency: false,
  clipping: true,
  cursorMapping: true,
  resize: 'intrinsic',
  viewportSharing: 'shared',
  safeDetach: true,
  rebinding: true,
  placeholder: false,
  snapshotHooks: false,
});

/** A canvas the host draws, as the geometry backend takes it: its revision rises with its pixels. */
export interface CanvasHandle {
  readonly key: string;
  readonly source: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
}

/** One of the host's views: where its window stands, and the surfaces it holds. */
interface View {
  readonly id: string;
  readonly label: string;
  readonly kind: Kind;
  /** Degrees right of straight ahead. */
  readonly heading: number;
  /** World units up from the eye. */
  readonly height: number;
  /** World units from the camera. */
  readonly distance: number;
  readonly surfaces: readonly {
    readonly key: string;
    readonly label: string;
    readonly adapter: typeof ELEMENT_ADAPTER | typeof CANVAS_ADAPTER;
    readonly width: number;
    readonly height: number;
  }[];
}

/** The views the host opens with, round the reader. */
const VIEWS: readonly View[] = Object.freeze([
  {
    id: 'notes',
    label: 'Notes',
    kind: 'notes',
    heading: -32,
    height: 0.1,
    distance: 3,
    surfaces: [{ key: 'notes', label: 'Notes', adapter: ELEMENT_ADAPTER, width: 1.5, height: 1 }],
  },
  {
    id: 'tasks',
    label: 'Tasks',
    kind: 'tasks',
    heading: 0,
    height: 0.1,
    distance: 3,
    surfaces: [{ key: 'tasks', label: 'Tasks', adapter: ELEMENT_ADAPTER, width: 1.3, height: 1 }],
  },
  {
    id: 'run',
    label: 'Run',
    kind: 'run',
    heading: 32,
    height: 0.1,
    distance: 3,
    surfaces: [{ key: 'run', label: 'Run', adapter: ELEMENT_ADAPTER, width: 1.3, height: 0.9 }],
  },
  {
    id: 'log',
    label: 'Session log',
    kind: 'log',
    heading: 66,
    height: 0,
    distance: 3.5,
    surfaces: [{ key: 'log', label: 'Log', adapter: ELEMENT_ADAPTER, width: 1.5, height: 1.1 }],
  },
  {
    id: 'mail',
    label: 'Mail',
    kind: 'mail',
    heading: -70,
    height: 0,
    distance: 3.5,
    surfaces: [
      { key: 'inbox', label: 'Inbox', adapter: ELEMENT_ADAPTER, width: 1.1, height: 1 },
      { key: 'outbox', label: 'Outbox', adapter: ELEMENT_ADAPTER, width: 1.1, height: 1 },
    ],
  },
  {
    id: 'clock',
    label: 'Clock',
    kind: 'clock',
    heading: 170,
    height: 0.2,
    distance: 3.4,
    surfaces: [{ key: 'clock', label: 'Clock', adapter: CANVAS_ADAPTER, width: 1, height: 1 }],
  },
]);

/** The commands that open the host's views round the camera, in a group orbit turns: one transaction. */
export function openingCommands(): SceneCommand[] {
  // The group's box holds every window wherever it is turned: a cube round the camera.
  const reach = Math.max(...VIEWS.map((view) => view.distance + 1.5));
  const commands: SceneCommand[] = [
    { type: 'camera.patch', id: CAMERA_ID, position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    {
      type: 'node.create',
      node: { id: 'desk', kind: 'group', label: 'Desk', bounds: [2 * reach, 2 * reach, 2 * reach] },
    },
  ];
  for (const view of VIEWS) {
    const radians = (view.heading * Math.PI) / 180;
    const layout = layoutSurfaces(view.surfaces.map((s) => [s.width, s.height] as const));
    commands.push({
      type: 'node.create',
      node: {
        id: view.id,
        kind: 'window',
        parentId: 'desk',
        label: view.label,
        tags: [view.kind],
        metadata: { [KIND_KEY]: view.kind },
        bounds: layout.bounds,
        transform: {
          position: [
            view.distance * Math.sin(radians),
            view.height,
            -view.distance * Math.cos(radians),
          ],
          rotation: cameraRotation(radians, 0),
          scale: [1, 1, 1],
        },
      },
    });
    view.surfaces.forEach((surface, i) => {
      commands.push({
        type: 'surface.attach',
        surface: {
          id: `${view.id}/${surface.key}`,
          ownerNodeId: view.id,
          label: surface.label,
          bindingKey: surface.key,
          adapterTypeId: surface.adapter,
          bounds: [surface.width, surface.height, 0.01],
          transform: {
            position: layout.offsets[i] ?? [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      });
    });
  }
  commands.push({ type: 'orbitRoot.set', nodeId: 'desk' });
  return commands;
}

/** What a page element of the host's content is styled with: the kit's own colours and type. */
const SURFACE_STYLE =
  'box-sizing:border-box;width:100%;height:100%;margin:0;padding:1.6em 0.8em 0.6em;overflow:auto;' +
  'font:13px var(--vscode-font-family, sans-serif);color:var(--vscode-editor-foreground);' +
  'background:var(--vscode-editor-background);';

/** The host's content: its live elements and canvases, its adapters and what it says of them. */
export interface HostViews {
  /** The adapters the host registers. */
  readonly adapters: readonly SurfaceAdapter[];
  /** What the host says of its windows. */
  readonly windows: WindowTraits;
  /** What the host says of its content, for the controls. */
  readonly content: HostContent;
  /** The live element a binding key names: the same element for as long as the host runs. */
  element(key: string): HTMLElement;
  /** Starts the content that runs by itself (the log, the clock), with what to call when it redraws. */
  run(redrawn: () => void): () => void;
}

/** The host's views, made once in a document. */
export function createHostViews(document: Document): HostViews {
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  };

  // Notes: a text area the reader types in, with its own undo and caret.
  const notes = make('textarea');
  notes.setAttribute('aria-label', 'Notes');
  notes.value = 'The host’s own editor: type here, then move, focus or turn the view.';
  notes.style.cssText = `${SURFACE_STYLE}resize:none;border:0;`;

  // Tasks: a list of checkboxes and a field that adds one.
  const tasks = make('form');
  tasks.setAttribute('aria-label', 'Tasks');
  tasks.style.cssText = SURFACE_STYLE;
  const list = make('ul');
  list.style.cssText = 'list-style:none;margin:0;padding:0;';
  const addTask = (text: string) => {
    const item = make('li');
    const label = make('label');
    const box = make('input');
    box.type = 'checkbox';
    label.append(box, ` ${text}`);
    item.append(label);
    list.append(item);
  };
  for (const text of ['Review the layout', 'Ship the controls', 'Record the demo']) {
    addTask(text);
  }
  const field = make('input');
  field.type = 'text';
  field.setAttribute('aria-label', 'New task');
  field.placeholder = 'New task, then Enter';
  tasks.append(list, field);
  tasks.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = field.value.trim();
    if (text !== '') {
      addTask(text);
      field.value = '';
    }
  });

  // Run: a form whose button counts its runs and says the last.
  const run = make('form');
  run.setAttribute('aria-label', 'Run');
  run.style.cssText = SURFACE_STYLE;
  const target = make('input');
  target.type = 'text';
  target.value = 'build';
  target.setAttribute('aria-label', 'Target');
  const go = make('button', 'Run');
  go.type = 'submit';
  const said = make('output', 'Not run yet');
  said.setAttribute('aria-live', 'polite');
  let runs = 0;
  run.append(target, ' ', go, make('p'), said);
  run.addEventListener('submit', (event) => {
    event.preventDefault();
    runs += 1;
    said.textContent = `Ran ${target.value} (${String(runs)})`;
  });

  // Session log: lines it adds by itself, scrolled where the reader left it.
  const log = make('ol');
  log.setAttribute('aria-label', 'Session log');
  log.style.cssText = `${SURFACE_STYLE}padding-left:2.4em;font-family:var(--vscode-editor-font-family, monospace);`;
  let lines = 0;
  const logLine = () => {
    lines += 1;
    log.append(make('li', `session ${String(lines)}: ok`));
  };
  for (let i = 0; i < 12; i += 1) {
    logLine();
  }

  // Mail: two surfaces of one window, each a list a press selects in.
  const box = (name: string, items: readonly string[]) => {
    const element = make('ul');
    element.setAttribute('aria-label', name);
    element.style.cssText = SURFACE_STYLE;
    for (const text of items) {
      const item = make('li');
      const pick = make('button', text);
      pick.type = 'button';
      pick.addEventListener('click', () => {
        pick.setAttribute(
          'aria-pressed',
          pick.getAttribute('aria-pressed') === 'true' ? 'false' : 'true',
        );
      });
      item.append(pick);
      element.append(item);
    }
    return element;
  };
  const inbox = box('Inbox', ['Layout review', 'Demo script', 'Weekly notes']);
  const outbox = box('Outbox', ['Release plan', 'Reply: controls']);

  const elements = new Map<string, HTMLElement>([
    ['notes', notes],
    ['tasks', tasks],
    ['run', run],
    ['log', log],
    ['inbox', inbox],
    ['outbox', outbox],
  ]);

  // Clock: a canvas the host draws each second.
  const clockCanvas = make('canvas');
  clockCanvas.width = 240;
  clockCanvas.height = 240;
  let clockRevision = 0;
  const drawClock = () => {
    const g = clockCanvas.getContext('2d');
    if (g === null) {
      throw new Error('the clock has no 2D drawing context');
    }
    const view = document.defaultView;
    const ink = view === null ? '#1f1f1f' : view.getComputedStyle(document.body).color;
    const now = new Date();
    g.fillStyle = '#f4f4f4';
    g.fillRect(0, 0, 240, 240);
    g.strokeStyle = ink;
    g.lineWidth = 6;
    g.beginPath();
    g.arc(120, 120, 100, 0, 2 * Math.PI);
    g.stroke();
    const hand = (turn: number, length: number, width: number) => {
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(120, 120);
      g.lineTo(
        120 + length * Math.sin(turn * 2 * Math.PI),
        120 - length * Math.cos(turn * 2 * Math.PI),
      );
      g.stroke();
    };
    hand(((now.getHours() % 12) + now.getMinutes() / 60) / 12, 55, 8);
    hand(now.getMinutes() / 60, 80, 5);
    hand(now.getSeconds() / 60, 90, 2);
    clockRevision += 1;
  };
  drawClock();
  const clock: CanvasHandle = {
    key: 'clock',
    source: clockCanvas,
    width: 240,
    height: 240,
    get revision() {
      return clockRevision;
    },
  };

  // An element taken out of the page forgets where it was scrolled: the host keeps that itself
  // while the element is detached (a handoff between backends moves it to another slot).
  const scrolled = new WeakMap<HTMLElement, { readonly top: number; readonly left: number }>();
  const elementAdapter: SurfaceAdapter<HTMLElement> = Object.freeze({
    id: ELEMENT_ADAPTER,
    apiVersion: ADAPTER_API_VERSION,
    declaredCapabilities: ELEMENT_CAPABILITIES,
    resolve: (key: string) => Promise.resolve(elements.get(key) ?? null),
    capabilities: () => ELEMENT_CAPABILITIES,
    attach(element: HTMLElement, at: { readonly container: unknown }) {
      if (!(at.container instanceof HTMLElement)) {
        throw new Error(`${ELEMENT_ADAPTER} attaches only into an element`);
      }
      at.container.append(element);
      const was = scrolled.get(element);
      if (was !== undefined) {
        element.scrollTop = was.top;
        element.scrollLeft = was.left;
        scrolled.delete(element);
      }
    },
    update: () => undefined,
    detach(element: HTMLElement) {
      scrolled.set(element, { top: element.scrollTop, left: element.scrollLeft });
      element.remove();
    },
  });
  const canvasAdapter: SurfaceAdapter<CanvasHandle> = Object.freeze({
    id: CANVAS_ADAPTER,
    apiVersion: ADAPTER_API_VERSION,
    declaredCapabilities: CANVAS_CAPABILITIES,
    resolve: (key: string) => Promise.resolve(key === 'clock' ? clock : null),
    capabilities: () => CANVAS_CAPABILITIES,
    // The clock is drawn by the geometry backend from its handle: nothing is mounted.
    attach: () => undefined,
    update: () => undefined,
    detach: () => undefined,
  });

  /** Small pictures of each element's text, for the focus strip, drawn again when it changes. */
  const pictures = new Map<string, { text: string; picture: ContentPreview }>();
  const picture = (key: string, text: string): ContentPreview => {
    const known = pictures.get(key);
    if (known?.text === text) {
      return known.picture;
    }
    const canvas = make('canvas');
    canvas.width = 180;
    canvas.height = 120;
    const g = canvas.getContext('2d');
    if (g === null) {
      throw new Error('a preview has no 2D drawing context');
    }
    g.fillStyle = '#f4f4f4';
    g.fillRect(0, 0, 180, 120);
    g.fillStyle = '#1f1f1f';
    g.font = '11px sans-serif';
    text
      .split('\n')
      .flatMap((line) => line.match(/.{1,28}/g) ?? [''])
      .slice(0, 8)
      .forEach((line, i) => {
        g.fillText(line, 8, 16 + i * 13);
      });
    const made: ContentPreview = {
      source: canvas,
      width: 180,
      height: 120,
      revision: (known?.picture.revision ?? 0) + 1,
    };
    pictures.set(key, { text, picture: made });
    return made;
  };

  const kindOf = (node: NodeRecord): Kind | null => {
    const kind = node.metadata[KIND_KEY];
    return typeof kind === 'string' && Object.hasOwn(KINDS, kind) ? (kind as Kind) : null;
  };

  return Object.freeze({
    adapters: [elementAdapter, canvasAdapter] as readonly SurfaceAdapter[],
    windows: Object.freeze({
      partOfKey: PART_OF_KEY,
      searchKeys: [KIND_KEY],
      category: (node: NodeRecord) => {
        const kind = kindOf(node);
        return kind === null ? null : KINDS[kind];
      },
      arrangeKey: (node: NodeRecord) => kindOf(node) ?? '',
      newWindowFor(surface: { readonly bindingKey: string | null }) {
        const kind: Kind | null =
          surface.bindingKey === 'clock'
            ? 'clock'
            : surface.bindingKey === 'inbox' || surface.bindingKey === 'outbox'
              ? 'mail'
              : null;
        const metadata: Record<string, JsonValue> = kind === null ? {} : { [KIND_KEY]: kind };
        return { tags: kind === null ? [] : [kind], metadata };
      },
    }),
    content: Object.freeze({
      describe: (surface: { readonly adapterTypeId: string }) =>
        surface.adapterTypeId === CANVAS_ADAPTER ? 'A drawing' : 'A live page element',
      kind: (node: NodeRecord) => {
        const kind = kindOf(node);
        return kind === null ? null : KINDS[kind];
      },
      preview: (key: string): ContentPreview | null => {
        if (key === 'clock') {
          return clock;
        }
        const element = elements.get(key);
        if (element === undefined) {
          return null;
        }
        const text =
          element instanceof HTMLTextAreaElement
            ? element.value
            : element.innerText || element.textContent || '';
        return picture(key, text);
      },
    }),
    element(key: string): HTMLElement {
      const element = elements.get(key);
      if (element === undefined) {
        throw new Error(`the host has no element "${key}"`);
      }
      return element;
    },
    run(redrawn: () => void): () => void {
      const view = document.defaultView;
      if (view === null) {
        throw new Error('the document is not in a window');
      }
      const ticks = view.setInterval(() => {
        drawClock();
        redrawn();
      }, 1000);
      const logs = view.setInterval(logLine, 2500);
      return () => {
        view.clearInterval(ticks);
        view.clearInterval(logs);
      };
    },
  });
}
