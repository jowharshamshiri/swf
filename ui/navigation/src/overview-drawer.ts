import type { Hue, StageUnit } from '@wsb/uikit/components';
import { HUES } from '@wsb/uikit/components';
import { resolvePalette } from '@wsb/uikit/primitives';
import type { Navigation } from '@swf/navigation';
import type { OverviewEntry, OverviewLayout, OverviewScene } from '@swf/navigation';
import { CARD, VIEWPORT_ID, inView, layOverview, overviewScene } from '@swf/navigation';
import type { NavigationMessages } from './messages.js';

/**
 * Draws the spatial overview on the kit's stage and works it. The board is the whole sphere round
 * the camera unrolled, as the panorama unrolls it: straight ahead in the middle, left and right a
 * quarter of the way to each edge, behind at both edges (shaded, as the panorama shades it), and
 * the horizon across. Each window is a card where the overview model puts it (`layOverview`):
 * across the board exactly at its heading, as near its elevation as the cards beside it allow. A
 * card's strip is the colour of the group it is in; its frame is in the selection's colour while it
 * is selected and ringed while it is focused; a window the panorama does not show now, and one its
 * group hides, are faded, and one the search leaves out is barely there, unnamed. Names and what each card says are the
 * stage's units, real text over the drawing.
 *
 * It is read from the scene, previews included, every time the scene changes, and keeps nothing
 * of the scene's: a press on a card selects its window and a double press focuses it, both through
 * the application's commands, so every view shows the same selection and focus.
 */

/** The strip across the top of the board where its regions are named, in CSS pixels. */
export const OVERVIEW_HEAD = 24;
/** A card's coloured strip, in its own pixels. */
const BAND = 7;
/** A card's corner radius, in its own pixels. */
const RADIUS = 4;
/** Room for a region's name, in CSS pixels. */
const READING = Object.freeze({ width: 72, height: 22 });
/** A card narrower than this on screen is too small for its name. */
const TITLED = 72;
/** A card at least this scale says where its window is. */
const OPEN = 0.7;
/** A window's mark while the board is too crowded for cards, its radius in CSS pixels. */
const DOT = 3;

/** The palette colours the board is drawn in, by their VS Code names. */
const INKS = Object.freeze({
  ground: 'editorWidget.background',
  behind: 'input.background',
  card: 'editor.background',
  rule: 'panel.border',
  quiet: 'descriptionForeground',
  accent: 'focusBorder',
  focused: 'editorWarning.foreground',
});
type Inks = { readonly [K in keyof typeof INKS]: string };

/** The kit's hues a group's cards are coloured in, in turn: grey says no group. */
const GROUP_HUES: readonly Hue[] = Object.freeze(HUES.filter((hue) => hue !== 'grey'));

/** The hue of the group at this place in the scene's groups. */
export function groupHue(index: number): Hue {
  const hue = GROUP_HUES[index % GROUP_HUES.length];
  if (hue === undefined) {
    throw new Error('the kit has no hue for a group');
  }
  return hue;
}

export interface OverviewDrawerOptions {
  readonly app: Navigation;
  readonly messages: NavigationMessages;
  readonly viewport: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** The names and readings to lay over the drawing, as the stage shows them. */
  readonly onunits: (units: StageUnit[]) => void;
  /** The board was laid out again: as cards, or crowded. */
  readonly onlayout: (layout: OverviewLayout) => void;
  /** A press on a card: select its window. */
  readonly onselect: (id: string) => void;
  /** A double press on a card: focus its window. */
  readonly onopen: (id: string) => void;
}

/** What one drawing showed: the scene, the board's layout, and where each card is on screen. */
interface Drawn {
  readonly scene: OverviewScene;
  readonly layout: OverviewLayout;
  /** Each card's box on screen, in the order drawn: the last lies on top. */
  readonly boxes: readonly { id: string; x: number; y: number; width: number; height: number }[];
}

export class OverviewDrawer {
  readonly #options: OverviewDrawerOptions;
  #inks: Inks;
  #hues: readonly string[];
  #size: { width: number; height: number };
  /** The windows the search finds, or null while it finds every window. */
  #found: ReadonlySet<string> | null = null;
  #drawn: Drawn | null = null;
  #frame: number | null = null;
  readonly #stops: (() => void)[] = [];

  constructor(options: OverviewDrawerOptions) {
    this.#options = options;
    const { viewport, app } = options;
    const box = viewport.getBoundingClientRect();
    this.#size = { width: box.width, height: box.height };
    this.#inks = this.#readInks();
    this.#hues = this.#readHues();
    const document = viewport.ownerDocument;
    const window = document.defaultView;
    if (window === null) {
      throw new Error('the overview is not in a window');
    }

    const resize = new ResizeObserver(() => {
      const next = viewport.getBoundingClientRect();
      this.#size = { width: next.width, height: next.height };
      this.#schedule();
    });
    resize.observe(viewport);
    this.#stops.push(() => {
      resize.disconnect();
    });

    // The scene, and every preview of it, redraws the board.
    this.#stops.push(
      app.workspace.subscribe(() => {
        this.#schedule();
      }),
    );

    // An appearance or theme changes the palette.
    const repaint = () => {
      this.#inks = this.#readInks();
      this.#hues = this.#readHues();
      this.#schedule();
    };
    const appearance = new MutationObserver(repaint);
    appearance.observe(document.documentElement, { attributes: true });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', repaint);
    this.#stops.push(() => {
      appearance.disconnect();
      scheme.removeEventListener('change', repaint);
    });

    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
    ) => {
      viewport.addEventListener(type, handler);
      this.#stops.push(() => {
        viewport.removeEventListener(type, handler);
      });
    };
    listen('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }
      const id = this.cardAt(...this.#local(event));
      if (id !== null) {
        event.preventDefault();
        this.#options.onselect(id);
      }
    });
    listen('dblclick', (event) => {
      const id = this.cardAt(...this.#local(event));
      if (id !== null) {
        event.preventDefault();
        this.#options.onopen(id);
      }
    });
    this.#schedule();
  }

  /** The board as last laid out, or null before it is first drawn. */
  get layout(): OverviewLayout | null {
    return this.#drawn?.layout ?? null;
  }

  /** The window whose card is under a point of the board, in CSS pixels from its corner. */
  cardAt(x: number, y: number): string | null {
    const boxes = this.#drawn?.boxes ?? [];
    for (let i = boxes.length - 1; i >= 0; i--) {
      const box = boxes[i];
      if (
        box !== undefined &&
        x >= box.x &&
        x <= box.x + box.width &&
        y >= box.y &&
        y <= box.y + box.height
      ) {
        return box.id;
      }
    }
    return null;
  }

  /** Where a window's card is on screen now, in CSS pixels from the board's corner. */
  cardBox(id: string): { x: number; y: number; width: number; height: number } | null {
    return this.#drawn?.boxes.find((box) => box.id === id) ?? null;
  }

  /** The windows the search finds, or null while it finds every window: the rest are faded. */
  setFound(found: ReadonlySet<string> | null): void {
    this.#found = found;
    this.#schedule();
  }

  dispose(): void {
    if (this.#frame !== null) {
      this.#options.viewport.ownerDocument.defaultView?.cancelAnimationFrame(this.#frame);
    }
    for (const stop of this.#stops.splice(0)) {
      stop();
    }
  }

  #readInks(): Inks {
    const palette = resolvePalette(this.#options.viewport.ownerDocument.documentElement);
    const ink = (name: string): string => {
      const value = palette[name];
      if (value === undefined) {
        throw new Error(`the kit's palette has no colour "${name}"`);
      }
      return value;
    };
    return {
      ground: ink(INKS.ground),
      behind: ink(INKS.behind),
      card: ink(INKS.card),
      rule: ink(INKS.rule),
      quiet: ink(INKS.quiet),
      accent: ink(INKS.accent),
      focused: ink(INKS.focused),
    };
  }

  /** Each group hue as the page paints it now, read from the kit's hue tokens. */
  #readHues(): readonly string[] {
    const root = this.#options.viewport.ownerDocument.documentElement;
    const probe = root.ownerDocument.createElement('span');
    probe.hidden = true;
    root.appendChild(probe);
    try {
      return GROUP_HUES.map((hue) => {
        probe.style.color = `var(--wsb-hue-${hue})`;
        const colour = getComputedStyle(probe).color;
        if (colour === '') {
          throw new Error(`the kit's hue "${hue}" could not be read`);
        }
        return colour;
      });
    } finally {
      probe.remove();
    }
  }

  #schedule(): void {
    const window = this.#options.viewport.ownerDocument.defaultView;
    if (this.#frame !== null || window === null) {
      return;
    }
    this.#frame = window.requestAnimationFrame(() => {
      this.#frame = null;
      this.#draw();
    });
  }

  #local(event: MouseEvent): [number, number] {
    const box = this.#options.viewport.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }

  #draw(): void {
    const { canvas, app, messages } = this.#options;
    const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const { width, height } = this.#size;
    const pixels = {
      width: Math.max(1, Math.round(width * ratio)),
      height: Math.max(1, Math.round(height * ratio)),
    };
    if (canvas.width !== pixels.width || canvas.height !== pixels.height) {
      canvas.width = pixels.width;
      canvas.height = pixels.height;
    }
    const g = canvas.getContext('2d');
    if (g === null) {
      throw new Error('the overview has no 2D drawing context');
    }
    const ink = this.#inks;
    const presented = app.workspace.getPresented();
    const scene = overviewScene(presented, VIEWPORT_ID, app.windows.category);
    const board = { width, height: Math.max(0, height - OVERVIEW_HEAD) };
    const layout = layOverview(scene.entries, board.width, board.height);
    const shown = new Set(
      scene.entries
        .filter((entry) => inView(presented, VIEWPORT_ID, app.projections, entry.id))
        .map((entry) => entry.id),
    );
    const byId = new Map(scene.entries.map((entry) => [entry.id, entry]));
    const hueOf = new Map(scene.groups.map((group, i) => [group.id, i]));
    // Where a heading's card centre is across the board, and an elevation's down it.
    const cardWidth = layout.kind === 'laid' ? layout.width : 0;
    const cardHeight = layout.kind === 'laid' ? layout.height : 0;
    const across = (heading: number) =>
      cardWidth / 2 + ((heading + 180) / 360) * Math.max(0, board.width - cardWidth);
    const down = (elevation: number) =>
      OVERVIEW_HEAD +
      cardHeight / 2 +
      ((90 - elevation) / 180) * Math.max(0, board.height - cardHeight);

    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.fillStyle = ink.ground;
    g.fillRect(0, 0, width, height);
    // Behind the camera: the two outer quarters of the board.
    g.fillStyle = ink.behind;
    g.fillRect(0, OVERVIEW_HEAD, across(-90), board.height);
    g.fillRect(across(90), OVERVIEW_HEAD, width - across(90), board.height);
    // Left, ahead and right, and the horizon.
    g.strokeStyle = ink.rule;
    g.lineWidth = 1;
    g.beginPath();
    for (const heading of [-90, 0, 90]) {
      const x = Math.round(across(heading)) + 0.5;
      g.moveTo(x, OVERVIEW_HEAD);
      g.lineTo(x, height);
    }
    g.moveTo(0, OVERVIEW_HEAD + 0.5);
    g.lineTo(width, OVERVIEW_HEAD + 0.5);
    g.stroke();
    g.setLineDash([4, 4]);
    g.beginPath();
    const horizon = Math.round(down(0)) + 0.5;
    g.moveTo(0, horizon);
    g.lineTo(width, horizon);
    g.stroke();
    g.setLineDash([]);

    // Left out by the search: barely there. Not shown in the panorama now, or hidden by its
    // group: faded.
    const left = (entry: OverviewEntry) => this.#found !== null && !this.#found.has(entry.id);
    const faded = (entry: OverviewEntry) => left(entry) || !entry.visible || !shown.has(entry.id);
    const alpha = (entry: OverviewEntry) => (left(entry) ? 0.25 : faded(entry) ? 0.45 : 1);
    const units: StageUnit[] = [];
    const reading = (key: string, title: string, centre: number, x?: number) => {
      units.push({
        key,
        title,
        x: x ?? Math.min(width - READING.width, Math.max(0, centre - READING.width / 2)),
        y: 0,
        width: READING.width,
        height: READING.height,
        scale: 1,
        depth: 0,
        container: false,
        band: 0,
        emphasis: 'quiet',
        titled: true,
        open: false,
        interactive: false,
      });
    };
    reading('region.behind-left', messages.format('overview.region.behind'), 0, 0);
    reading('region.left', messages.format('overview.region.left'), across(-90));
    reading('region.ahead', messages.format('overview.region.ahead'), across(0));
    reading('region.right', messages.format('overview.region.right'), across(90));
    reading(
      'region.behind-right',
      messages.format('overview.region.behind'),
      width,
      Math.max(0, width - READING.width),
    );

    const boxes: { id: string; x: number; y: number; width: number; height: number }[] = [];
    if (layout.kind === 'crowded') {
      // Too many for cards: each window a dot where it stands, and the list names them.
      for (const entry of scene.entries) {
        g.globalAlpha = alpha(entry);
        g.fillStyle = entry.selected ? ink.accent : ink.quiet;
        g.beginPath();
        g.arc(across(entry.heading), down(entry.elevation), DOT, 0, 2 * Math.PI);
        g.fill();
        boxes.push({
          id: entry.id,
          x: across(entry.heading) - DOT,
          y: down(entry.elevation) - DOT,
          width: 2 * DOT,
          height: 2 * DOT,
        });
      }
      g.globalAlpha = 1;
    } else {
      const { scale } = layout;
      // The selected and the focused are drawn last, on top.
      const order = [...layout.cards].sort((a, b) => rank(byId.get(a.id)) - rank(byId.get(b.id)));
      for (const card of order) {
        const entry = byId.get(card.id);
        if (entry === undefined) {
          throw new Error(`the overview has a card for no window ("${card.id}")`);
        }
        const x = card.x;
        const y = OVERVIEW_HEAD + card.y;
        const w = layout.width;
        const h = layout.height;
        const radius = Math.min(RADIUS * scale, w / 4, h / 4);
        g.globalAlpha = alpha(entry);
        g.fillStyle = ink.card;
        g.beginPath();
        g.roundRect(x, y, w, h, radius);
        g.fill();
        // The strip: the colour of its group, or the rule's when it is in none.
        const hue = entry.group === null ? undefined : hueOf.get(entry.group.id);
        g.fillStyle =
          hue === undefined ? ink.rule : (this.#hues[hue % this.#hues.length] ?? ink.rule);
        g.beginPath();
        g.roundRect(x, y, w, Math.max(2, BAND * scale), [radius, radius, 0, 0]);
        g.fill();
        g.globalAlpha = alpha(entry);
        g.strokeStyle = entry.selected ? ink.accent : ink.rule;
        g.lineWidth = entry.selected ? 2 : 1;
        g.beginPath();
        g.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, radius);
        g.stroke();
        g.globalAlpha = 1;
        if (entry.focused) {
          g.strokeStyle = ink.focused;
          g.lineWidth = 2;
          g.beginPath();
          g.roundRect(x - 3, y - 3, w + 6, h + 6, radius + 3);
          g.stroke();
        }
        boxes.push({ id: entry.id, x, y, width: w, height: h });
        // A card the search leaves out keeps its place, unnamed, so the ones it finds stand out.
        const titled = w >= TITLED && !left(entry);
        const open = titled && scale >= OPEN;
        units.push({
          key: entry.id,
          title: entry.label,
          content: open ? this.#says(entry) : undefined,
          x,
          y,
          width: CARD.width,
          height: CARD.height,
          scale,
          depth: entry.selected ? 3 : entry.focused ? 2 : 1,
          container: false,
          band: BAND,
          emphasis: faded(entry) ? 'quiet' : undefined,
          titled,
          open,
          interactive: false,
        });
      }
    }
    this.#drawn = { scene, layout, boxes };
    this.#options.onlayout(layout);
    this.#options.onunits(units);
  }

  /** What a card says under its name: where its window is, then its group, kind and parts. */
  #says(entry: OverviewEntry): string {
    const t = this.#options.messages;
    const where = t.format('overview.where', {
      heading: Math.round(Math.abs(entry.heading)),
      side: t.format(entry.heading < 0 ? 'where.left' : 'where.right'),
      distance: Number(entry.distance.toFixed(1)),
    });
    // Each said once: a group named as the category is one mark.
    const marks = [
      ...new Set([
        ...(entry.group === null ? [] : [entry.group.label]),
        ...(entry.category === null ? [] : [entry.category]),
        ...(entry.parts > 1 ? [t.format('overview.parts', { count: entry.parts })] : []),
      ]),
    ];
    const line = `<p><span>${escape(where)}</span></p>`;
    return marks.length === 0
      ? line
      : `${line}<ul>${marks.map((mark) => `<li>${escape(mark)}</li>`).join('')}</ul>`;
  }
}

/** The order cards are drawn in: the focused over the rest, the selected over all. */
function rank(entry: OverviewEntry | undefined): number {
  return entry === undefined ? 0 : entry.selected ? 2 : entry.focused ? 1 : 0;
}

/** Text written into a unit's HTML as text. */
function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
