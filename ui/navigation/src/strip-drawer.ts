import type { StageUnit } from '@wsb/uikit/components';
import { resolvePalette } from '@wsb/uikit/primitives';
import type { Navigation } from '@swf/navigation';
import type { StripCard, StripMetrics } from '@swf/navigation';
import { FOCUS_ID, VIEWPORT_ID, stripLayout, stripWindows } from '@swf/navigation';
import type { ContentPreview } from './model.svelte.js';

/**
 * Draws the focus strip on the kit's stage and works it: each window a card where the strip's
 * layout puts it, its name the stage's unit (real text, in the kit's look, never over another
 * card) and under it the host's own picture of what it holds (a tile's drawing, a note drawn
 * small), drawn again whenever that picture changes, so the strip stays live. The focused window's
 * card is framed in the focus colour; windows behind the camera have quieter names. A press on a
 * card focuses its window; with the strip's keyboard stop, the arrows step to the next window
 * either way.
 */

/** How large the strip's cards may be, in CSS pixels: a name fits two words to a line. */
export const STRIP_METRICS: StripMetrics = Object.freeze({ least: 96, most: 160, gap: 6 });

/** The palette colours the strip is drawn in, by their VS Code names. */
const INKS = Object.freeze({
  rule: 'panel.border',
  focused: 'editorWarning.foreground',
});
type Inks = { readonly [K in keyof typeof INKS]: string };

/** A card as drawn: where its picture went, below its name. */
export interface DrawnCard extends StripCard {
  readonly picture: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface StripDrawerOptions {
  readonly app: Navigation;
  /** The host's picture of the content a binding key binds, or null for none. */
  readonly preview: (key: string) => ContentPreview | null;
  readonly viewport: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** The layer the stage lays its units in, where each card's name is measured. */
  readonly layer: () => HTMLElement | undefined;
  /** The names to lay over the drawing, as the stage shows them. */
  readonly onunits: (units: StageUnit[]) => void;
  /** The windows the strip has no room for, by name, nearest first. */
  readonly onhidden: (labels: readonly string[]) => void;
  /** A press on a card, or an arrow from the keyboard stop: focus that window. */
  readonly onfocus: (id: string) => void;
  readonly onstep: (direction: 'left' | 'right') => void;
}

export class StripDrawer {
  readonly #options: StripDrawerOptions;
  #inks: Inks;
  /** The names last handed to the stage. */
  #layoutUnits: StageUnit[] = [];
  /** The names of the windows last left out. */
  #hiddenLabels: readonly string[] = [];
  #drawn: DrawnCard[] = [];
  /** What the last drawing showed, so a frame that would show the same draws nothing. */
  #signature = '';
  #frame: number | null = null;
  #down: readonly [number, number] | null = null;
  readonly #stops: (() => void)[] = [];

  constructor(options: StripDrawerOptions) {
    this.#options = options;
    this.#inks = this.#readInks();
    const { viewport, app } = options;
    const window = viewport.ownerDocument.defaultView;
    if (window === null) {
      throw new Error('the focus strip is not in a window');
    }
    const resize = new ResizeObserver(() => {
      this.#schedule();
    });
    resize.observe(viewport);
    this.#stops.push(() => {
      resize.disconnect();
    });
    this.#stops.push(
      app.workspace.subscribe(() => {
        this.#schedule();
      }),
    );
    const appearance = new MutationObserver(() => {
      this.#inks = this.#readInks();
      this.#signature = '';
      this.#schedule();
    });
    appearance.observe(viewport.ownerDocument.documentElement, { attributes: true });
    this.#stops.push(() => {
      appearance.disconnect();
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
    // A press that does not move is a choice of window.
    listen('pointerdown', (event) => {
      this.#down = event.button === 0 ? this.#local(event) : null;
    });
    listen('pointerup', (event) => {
      const start = this.#down;
      this.#down = null;
      const [x, y] = this.#local(event);
      if (start === null || Math.hypot(x - start[0], y - start[1]) > 4) {
        return;
      }
      const card = this.#drawn.find(
        (c) => x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height,
      );
      if (card !== undefined && !card.window.focused) {
        options.onfocus(card.window.id);
      }
    });
    listen('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        options.onstep(event.key === 'ArrowLeft' ? 'left' : 'right');
      }
    });
    // The host's pictures change on their own (a note written in): look for it every frame.
    const watch = () => {
      this.#schedule();
      watching = window.requestAnimationFrame(watch);
    };
    let watching = window.requestAnimationFrame(watch);
    this.#stops.push(() => {
      window.cancelAnimationFrame(watching);
    });
  }

  /** The cards as last drawn: where each name and picture lies. */
  cards(): readonly DrawnCard[] {
    return this.#drawn;
  }

  dispose(): void {
    const window = this.#options.viewport.ownerDocument.defaultView;
    if (this.#frame !== null) {
      window?.cancelAnimationFrame(this.#frame);
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
    return { rule: ink(INKS.rule), focused: ink(INKS.focused) };
  }

  #local(event: MouseEvent): [number, number] {
    const box = this.#options.viewport.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
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

  #draw(): void {
    const { app, viewport, canvas } = this.#options;
    const state = app.workspace.getState();
    const focused = state.focusedId;
    const camera = state.cameras.get(state.viewports.get(VIEWPORT_ID)?.cameraId ?? '');
    if (app.modes.current() !== FOCUS_ID || focused === null || camera === undefined) {
      return;
    }
    const box = viewport.getBoundingClientRect();
    const size = { width: Math.round(box.width), height: Math.round(box.height) };
    if (
      size.width < STRIP_METRICS.least + 2 * STRIP_METRICS.gap ||
      size.height < 3 * STRIP_METRICS.gap
    ) {
      return;
    }
    const layout = stripLayout(stripWindows(state, focused, camera.position), size, STRIP_METRICS);
    const behind = (bearing: number) => Math.abs(bearing) > 90;
    const units: StageUnit[] = layout.cards.map((card) => ({
      key: card.window.id,
      title: card.window.label,
      x: card.x,
      y: card.y,
      width: card.width,
      height: card.height,
      scale: 1,
      depth: 0,
      container: false,
      band: 0,
      emphasis: card.window.focused
        ? 'prominent'
        : behind(card.window.bearing)
          ? 'quiet'
          : undefined,
      titled: true,
      open: false,
      interactive: false,
    }));
    const hidden = [...layout.hidden.left, ...layout.hidden.right]
      .sort((a, b) => Math.abs(a.bearing) - Math.abs(b.bearing))
      .map((w) => w.label);
    if (JSON.stringify(hidden) !== JSON.stringify(this.#hiddenLabels)) {
      this.#hiddenLabels = hidden;
      this.#options.onhidden(hidden);
    }
    if (JSON.stringify(this.#layoutUnits) !== JSON.stringify(units)) {
      this.#layoutUnits = units;
      this.#options.onunits(units);
    }
    // Each card's picture goes under its name, as the stage has written it.
    const layer = this.#options.layer();
    const titleHeight = (id: string): number | null => {
      const title = layer?.querySelector<HTMLElement>(
        `[data-wsb="page.focus.strip.unit.title#${CSS.escape(id)}"]`,
      );
      return title === undefined || title === null ? null : title.offsetHeight;
    };
    const pictures = layout.cards.map((card) => {
      const surfaces = card.window.surfaces.map((s) => ({
        ...s,
        preview: this.#options.preview(s.key),
      }));
      return { card, surfaces };
    });
    const drawn: DrawnCard[] = [];
    for (const { card } of pictures) {
      const top = titleHeight(card.window.id);
      if (top === null) {
        // The stage has not written this name yet: draw once it has.
        this.#schedule();
        return;
      }
      const room = {
        x: card.x + 4,
        y: card.y + top,
        width: card.width - 8,
        height: card.height - top - 4,
      };
      // As large as the room allows, at the window's own proportions.
      const scale = Math.min(room.width / card.window.aspect, room.height);
      const width = Math.max(0, scale * card.window.aspect);
      const height = Math.max(0, scale);
      drawn.push({
        ...card,
        picture: {
          x: room.x + (room.width - width) / 2,
          y: room.y + (room.height - height) / 2,
          width,
          height,
        },
      });
    }
    const signature = JSON.stringify([
      size,
      drawn.map((c) => [c.window.id, c.picture]),
      pictures.map(({ surfaces }) => surfaces.map((s) => s.preview?.revision ?? null)),
      this.#inks,
    ]);
    this.#drawn = drawn;
    if (signature === this.#signature) {
      return;
    }
    this.#signature = signature;
    const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const pixels = {
      width: Math.max(1, Math.round(size.width * ratio)),
      height: Math.max(1, Math.round(size.height * ratio)),
    };
    if (canvas.width !== pixels.width || canvas.height !== pixels.height) {
      canvas.width = pixels.width;
      canvas.height = pixels.height;
    }
    const g = canvas.getContext('2d');
    if (g === null) {
      throw new Error('the focus strip has no 2D drawing context');
    }
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, size.width, size.height);
    drawn.forEach((card, i) => {
      const { picture } = card;
      const surfaces = pictures[i]?.surfaces ?? [];
      let x = picture.x;
      for (const surface of surfaces) {
        const width = picture.width * surface.share;
        if (surface.preview !== null) {
          this.#picture(g, surface.preview, x, picture.y, width, picture.height);
        }
        x += width;
      }
      g.lineWidth = card.window.focused ? 3 : 1;
      g.strokeStyle = card.window.focused ? this.#inks.focused : this.#inks.rule;
      const inset = g.lineWidth / 2;
      g.strokeRect(
        picture.x - inset,
        picture.y - inset,
        picture.width + 2 * inset,
        picture.height + 2 * inset,
      );
    });
  }

  /** Draws a picture into a box, whole, at its own proportions, centred. */
  #picture(
    g: CanvasRenderingContext2D,
    preview: ContentPreview,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const scale = Math.min(width / preview.width, height / preview.height);
    const w = preview.width * scale;
    const h = preview.height * scale;
    g.imageSmoothingQuality = 'high';
    g.drawImage(preview.source, x + (width - w) / 2, y + (height - h) / 2, w, h);
  }
}
