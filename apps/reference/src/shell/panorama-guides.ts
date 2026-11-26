import { resolvePalette } from '@wsb/uikit/primitives';
import { viewGeometryOf } from '@swf/presentation';
import { headingPitchOf, projectionFor } from '@swf/projections';
import type { ReferenceApp } from '../app.js';
import { VIEWPORT_ID } from '../app.js';
import type { PartLink } from '../map.js';
import { partLinks } from '../map.js';
import type { Messages } from '../messages.js';

/**
 * Guides drawn under the panorama's windows, so where things are around the camera is seen in the
 * panorama itself: the parts of the view that lie behind the camera are shaded and named, and,
 * while the view shows the whole circle, its two edges are marked as the seam where they meet, a
 * dashed line on each with its name; and each window made from another window's surface is linked
 * to that window by a dashed line along the shortest way round between them. Everything is placed
 * by the view's own projection, so the guides move with the camera, the windows and the field of
 * view, previews included.
 *
 * The guides sit in a holder of no size prepended to the panorama's container, as the framework's
 * virtual cursor does, under the presented view: they take no input and are hidden from assistive
 * technology, the radar's legend saying in words what they show.
 */

/** The palette colours the guides are drawn in, by their VS Code names. */
const INKS = Object.freeze({
  behind: 'input.background',
  rule: 'descriptionForeground',
  link: 'focusBorder',
});
type Inks = { readonly [K in keyof typeof INKS]: string };

/** The layer name the guides' holder carries. */
export const GUIDES_LAYER = 'reference-guides';

export interface PanoramaGuidesOptions {
  readonly app: ReferenceApp;
  readonly messages: Messages;
  /** The element the panorama is presented in. */
  readonly container: HTMLElement;
}

/** What the guides show of the view now, in its CSS pixels: what the tests and the drawing read. */
export interface GuideLayout {
  /** The spans of the view that lie behind the camera, each `[left, right]`. */
  readonly behind: readonly (readonly [number, number])[];
  /** The x of each seam edge marked: both edges of a full-circle view, else none. */
  readonly seams: readonly number[];
  /** Each part linked to the window it came from, and the runs of its line drawn. */
  readonly links: readonly PartLink[];
}

export class PanoramaGuides {
  readonly #options: PanoramaGuidesOptions;
  readonly #holder: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  #inks: Inks;
  #frame: number | null = null;
  #layout: GuideLayout = { behind: [], seams: [], links: [] };
  readonly #stops: (() => void)[] = [];

  constructor(options: PanoramaGuidesOptions) {
    this.#options = options;
    const { container, app } = options;
    const document = container.ownerDocument;
    const window = document.defaultView;
    if (window === null) {
      throw new Error('the panorama is not in a window');
    }
    this.#holder = document.createElement('div');
    this.#holder.setAttribute('data-swf-layer', GUIDES_LAYER);
    this.#holder.setAttribute('aria-hidden', 'true');
    set(this.#holder, {
      position: 'relative',
      width: '0px',
      height: '0px',
      overflow: 'visible',
      'pointer-events': 'none',
    });
    this.#canvas = document.createElement('canvas');
    set(this.#canvas, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      'pointer-events': 'none',
    });
    this.#holder.append(this.#canvas);
    container.prepend(this.#holder);
    this.#stops.push(() => {
      this.#holder.remove();
    });
    this.#inks = this.#readInks();

    // The scene and every preview of it, the view's size among them, move the guides.
    this.#stops.push(
      app.workspace.subscribe(() => {
        this.#schedule();
      }),
    );
    const appearance = new MutationObserver(() => {
      this.#inks = this.#readInks();
      this.#schedule();
    });
    appearance.observe(document.documentElement, { attributes: true });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      this.#inks = this.#readInks();
      this.#schedule();
    };
    scheme.addEventListener('change', onScheme);
    this.#stops.push(() => {
      appearance.disconnect();
      scheme.removeEventListener('change', onScheme);
    });
    this.#schedule();
  }

  /** What the guides showed when last drawn. */
  get layout(): GuideLayout {
    return this.#layout;
  }

  dispose(): void {
    if (this.#frame !== null) {
      this.#options.container.ownerDocument.defaultView?.cancelAnimationFrame(this.#frame);
      this.#frame = null;
    }
    for (const stop of this.#stops.splice(0)) {
      stop();
    }
  }

  #readInks(): Inks {
    const palette = resolvePalette(this.#options.container.ownerDocument.documentElement);
    const ink = (name: string): string => {
      const value = palette[name];
      if (value === undefined) {
        throw new Error(`the kit's palette has no colour "${name}"`);
      }
      return value;
    };
    return { behind: ink(INKS.behind), rule: ink(INKS.rule), link: ink(INKS.link) };
  }

  #schedule(): void {
    const window = this.#options.container.ownerDocument.defaultView;
    if (this.#frame !== null || window === null) {
      return;
    }
    this.#frame = window.requestAnimationFrame(() => {
      this.#frame = null;
      this.#draw();
    });
  }

  /** Where the guides go in the view as it is presented now. */
  #measure(): GuideLayout & { readonly width: number; readonly height: number } {
    const { app } = this.#options;
    const state = app.workspace.getPresented();
    const view = viewGeometryOf(state, VIEWPORT_ID);
    const module = app.projections.get(view.projectionId);
    if (module === undefined) {
      throw new Error(`projection "${view.projectionId}" is not registered`);
    }
    const projection = projectionFor(module, view);
    const { width, height } = view;
    const record = state.viewports.get(VIEWPORT_ID);
    const camera = record === undefined ? undefined : state.cameras.get(record.cameraId);
    if (camera === undefined) {
      throw new Error(`viewport "${VIEWPORT_ID}" has no camera`);
    }
    const { heading } = headingPitchOf(camera.rotation);
    /** Where the horizon's direction a quarter turn to one side of the heading is drawn. */
    const side = (sign: number): number | null => {
      const a = heading + (sign * Math.PI) / 2;
      const images = projection.projectDirection([Math.sin(a), 0, -Math.cos(a)], view).images;
      // A quarter turn lies within half the circle of the centre: its one image left or right.
      const image = images.find(([x]) => (sign < 0 ? x <= width / 2 : x >= width / 2));
      return image === undefined ? null : image[0];
    };
    const left = side(-1);
    const right = side(1);
    const behind: [number, number][] = [];
    if (left !== null && left > 0) {
      behind.push([0, left]);
    }
    if (right !== null && right < width) {
      behind.push([right, width]);
    }
    const domain = projection.describeDomain();
    const seams = domain.fullCircle && domain.seamWrapping ? [0, width] : [];
    const links = partLinks(state, VIEWPORT_ID, app.projections);
    return { behind, seams, links, width, height };
  }

  #draw(): void {
    const measured = this.#measure();
    const { width, height } = measured;
    this.#layout = Object.freeze({
      behind: measured.behind,
      seams: measured.seams,
      links: measured.links,
    });
    const canvas = this.#canvas;
    const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const pixels = {
      width: Math.max(1, Math.round(width * ratio)),
      height: Math.max(1, Math.round(height * ratio)),
    };
    if (canvas.width !== pixels.width || canvas.height !== pixels.height) {
      canvas.width = pixels.width;
      canvas.height = pixels.height;
      set(canvas, { width: `${String(width)}px`, height: `${String(height)}px` });
    }
    const g = canvas.getContext('2d');
    if (g === null) {
      throw new Error('the panorama guides have no 2D drawing context');
    }
    const ink = this.#inks;
    const { messages, container } = this.#options;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);
    const font = container.ownerDocument.defaultView?.getComputedStyle(container).fontFamily;
    g.font = `12px ${font ?? 'sans-serif'}`;
    g.textBaseline = 'top';

    for (const [a, b] of measured.behind) {
      g.fillStyle = ink.behind;
      g.fillRect(a, 0, b - a, height);
      g.strokeStyle = ink.rule;
      g.globalAlpha = 0.5;
      g.lineWidth = 1;
      // The line where behind begins, on the side towards the centre.
      const edge = a === 0 ? b : a;
      g.beginPath();
      g.moveTo(edge + 0.5, 0);
      g.lineTo(edge + 0.5, height);
      g.stroke();
      g.globalAlpha = 1;
      const label = messages.format('guides.behind');
      const room = b - a - 12;
      if (g.measureText(label).width <= room) {
        g.fillStyle = ink.rule;
        g.textAlign = 'center';
        g.fillText(label, (a + b) / 2, 22);
      }
    }
    g.strokeStyle = ink.link;
    g.lineWidth = 1.5;
    g.setLineDash([6, 4]);
    for (const link of measured.links) {
      for (const run of link.runs) {
        g.beginPath();
        run.forEach(([x, y], i) => {
          if (i === 0) {
            g.moveTo(x, y);
          } else {
            g.lineTo(x, y);
          }
        });
        g.stroke();
      }
    }
    g.setLineDash([]);
    if (measured.seams.length > 0) {
      g.strokeStyle = ink.rule;
      g.lineWidth = 2;
      g.setLineDash([6, 5]);
      for (const x of measured.seams) {
        const at = x === 0 ? 1 : x - 1;
        g.beginPath();
        g.moveTo(at, 0);
        g.lineTo(at, height);
        g.stroke();
      }
      g.setLineDash([]);
      g.fillStyle = ink.rule;
      const label = messages.format('guides.seam');
      g.textAlign = 'left';
      g.fillText(label, 6, 6);
      g.textAlign = 'right';
      g.fillText(label, width - 6, 6);
    }
  }
}

function set(element: HTMLElement, properties: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(properties)) {
    element.style.setProperty(name, value);
  }
}
