import { resolvePalette } from '@wsb/uikit/primitives';
import { windowFrames } from '@swf/backend-geometry';
import type { Vec3 } from '@swf/math';
import type { NameObstacle, NameRequest, ScreenPoint } from '@swf/presentation';
import { placeNames, viewGeometryOf, windowNames } from '@swf/presentation';
import { headingPitchOf, projectionFor } from '@swf/projections';
import type { ReferenceApp } from '../app.js';
import type { PartLink } from '@swf/navigation';
import { VIEWPORT_ID, partLinks, traced } from '@swf/navigation';
import type { Messages } from '../messages.js';

/**
 * Guides drawn under the panorama's windows, so where things are around the camera is seen in the
 * panorama itself: a grid of headings round the camera every 15 degrees (every 45 stronger, and
 * written at the top as the radar writes its bearings) and of heights every 15 degrees, the
 * horizon the strongest; where the camera faces, a dashed line down the middle with its heading
 * written over it; the parts of the view that lie behind the camera, shaded and named; while the
 * view shows the whole circle, its two edges marked as the seam where they meet, a dashed line on
 * each with its name; and each window made from another window's part linked to that window by a
 * dashed line along the shortest way round between them. Everything is placed by the view's own
 * projection, so the guides move with the camera, the windows and the field of view, previews
 * included. Every word is written where it overlaps no other (`placeNames`): a heading at the top
 * gives way to where the camera faces, and to the seam's and behind's names.
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

/** Degrees between the grid's lines of heading and of height, and between its stronger lines. */
const GRID = Object.freeze({ step: 15, major: 45, reach: 75, sample: 5 });
/** How strongly each kind of grid line is drawn over the ground. */
const ALPHA = Object.freeze({ minor: 0.14, major: 0.3, horizon: 0.55, facing: 0.8 });
/** Where the words at the top are written: the seam's, behind's, and the headings' rows. */
const ROWS = Object.freeze({ seam: 6, behind: 22, heading: 40, line: 15 });
/** How far inside the view's edges a word is written, in CSS pixels. */
const EDGE = 6;
/** A window's name as the backends write it: the height of its line and its plate's margin. */
const NAME_PLATE = Object.freeze({ line: 15, margin: 3 });
/** The owner of what the windows draw, which the guides' words keep clear of. */
const WINDOWS = 'reference.guides.windows';

/** One line of the grid: its heading or height in degrees, and the runs it is drawn in. */
export interface GridLine {
  readonly degrees: number;
  readonly runs: readonly (readonly ScreenPoint[])[];
}

/** A word the guides write: what it names, what it says and the top-left of where it is written. */
export interface GuideWord {
  readonly kind: 'seam' | 'behind' | 'facing' | 'heading';
  readonly text: string;
  readonly at: ScreenPoint;
  /** Its width and height as written. */
  readonly size: readonly [number, number];
}

/** What the guides measure of the view before writing their words, with the view's size. */
type Measured = Omit<GuideLayout, 'words'> & { readonly width: number; readonly height: number };
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
  /** The lines of heading round the camera, every {@link GRID} step, as world headings. */
  readonly headings: readonly GridLine[];
  /** The lines of height, every {@link GRID} step above and below the horizon (0). */
  readonly heights: readonly GridLine[];
  /** Where the camera faces: the x of its line, and its heading in degrees to the right. */
  readonly facing: { readonly x: number; readonly degrees: number } | null;
  /** Every word written: the seam's and behind's names, where the camera faces, the headings. */
  readonly words: readonly GuideWord[];
}

export class PanoramaGuides {
  readonly #options: PanoramaGuidesOptions;
  readonly #holder: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  #inks: Inks;
  #frame: number | null = null;
  #layout: GuideLayout = {
    behind: [],
    seams: [],
    links: [],
    headings: [],
    heights: [],
    facing: null,
    words: [],
  };
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

    // The scene and every preview of it, the view's size among them, move the guides; each frame
    // presented moves the windows their words keep clear of.
    this.#stops.push(
      app.workspace.subscribe(() => {
        this.#schedule();
      }),
      app.presenter.subscribe((event) => {
        if (event.type === 'frame' && event.viewportId === VIEWPORT_ID) {
          this.#schedule();
        }
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
  #measure(): Measured {
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
    const links = partLinks(state, VIEWPORT_ID, app.projections, app.windows.partOfKey);
    const toward = (a: number, e: number): Vec3 => [
      Math.sin(a) * Math.cos(e),
      Math.sin(e),
      -Math.cos(a) * Math.cos(e),
    ];
    const radians = Math.PI / 180;
    const headings: GridLine[] = [];
    for (let degrees = -180 + GRID.step; degrees <= 180; degrees += GRID.step) {
      const along: Vec3[] = [];
      for (let e = -GRID.reach - GRID.step; e <= GRID.reach + GRID.step; e += GRID.sample) {
        along.push(toward(degrees * radians, e * radians));
      }
      headings.push({ degrees, runs: traced(projection, view, along) });
    }
    const heights: GridLine[] = [];
    for (let degrees = -GRID.reach; degrees <= GRID.reach; degrees += GRID.step) {
      const around: Vec3[] = [];
      for (let a = -180; a <= 180; a += GRID.sample) {
        around.push(toward(a * radians, degrees * radians));
      }
      heights.push({ degrees, runs: traced(projection, view, around) });
    }
    const facingImage = projection
      .projectDirection(toward(heading, 0), view)
      .images.find(([x]) => x >= 0 && x <= width);
    const facing =
      facingImage === undefined ? null : { x: facingImage[0], degrees: bearingOf(heading) };
    return { behind, seams, links, headings, heights, facing, width, height };
  }

  #draw(): void {
    const measured = this.#measure();
    const { width, height } = measured;
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
    const { container } = this.#options;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);
    const family = container.ownerDocument.defaultView?.getComputedStyle(container).fontFamily;
    if (family === undefined || family === '') {
      throw new Error('the panorama has no font to write its guides in');
    }
    g.font = `12px ${family}`;
    g.textBaseline = 'top';
    const words = this.#words(g, measured);
    this.#layout = Object.freeze({
      behind: measured.behind,
      seams: measured.seams,
      links: measured.links,
      headings: measured.headings,
      heights: measured.heights,
      facing: measured.facing,
      words,
    });

    // The grid, under everything else: heights, the horizon strongest, then headings.
    g.strokeStyle = ink.rule;
    g.lineWidth = 1;
    for (const line of measured.heights) {
      g.globalAlpha = line.degrees === 0 ? ALPHA.horizon : ALPHA.minor;
      stroke(g, line.runs);
    }
    for (const line of measured.headings) {
      g.globalAlpha = line.degrees % GRID.major === 0 ? ALPHA.major : ALPHA.minor;
      stroke(g, line.runs);
    }
    g.globalAlpha = 1;

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
    }
    g.strokeStyle = ink.link;
    g.lineWidth = 1.5;
    g.setLineDash([6, 4]);
    for (const link of measured.links) {
      stroke(g, link.runs);
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
    }
    // Where the camera faces: a dashed line down the middle, from below the words at the top.
    if (measured.facing !== null) {
      const x = Math.round(measured.facing.x) + 0.5;
      g.strokeStyle = ink.link;
      g.globalAlpha = ALPHA.facing;
      g.lineWidth = 1;
      g.setLineDash([4, 7]);
      g.beginPath();
      g.moveTo(x, ROWS.heading + ROWS.line + 4);
      g.lineTo(x, height);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }
    g.textAlign = 'left';
    for (const word of words) {
      g.fillStyle = word.kind === 'facing' ? ink.link : ink.rule;
      g.fillText(word.text, word.at[0], word.at[1]);
    }
  }

  /** What is written where the camera faces. */
  #facingText(facing: { readonly degrees: number } | null): string | null {
    return facing === null
      ? null
      : this.#options.messages.format('guides.facing', { value: facing.degrees });
  }

  /**
   * The words written over the view, each where it overlaps no word written before it and nothing
   * the windows draw over it (their frames and marks, and every place their names may go): the
   * seam's name at both top corners and behind's in the middle of each span behind the camera,
   * then where the camera faces, over its line, then each 45 degree heading over its line.
   */
  #words(g: CanvasRenderingContext2D, measured: Measured): GuideWord[] {
    const { messages } = this.#options;
    const { width, height } = measured;
    const requests: (NameRequest & { readonly kind: GuideWord['kind'] })[] = [];
    const ask = (kind: GuideWord['kind'], owner: string, text: string, x: number, y: number) => {
      const size: [number, number] = [Math.ceil(g.measureText(text).width), ROWS.line];
      // Clear of the view's edges, where the seam is marked.
      const at = Math.min(width - EDGE - size[0], Math.max(EDGE, x));
      requests.push({ kind, owner, text, size, places: [[at, y]] });
      return size;
    };
    if (measured.seams.length > 0) {
      const seam = messages.format('guides.seam');
      const [w] = ask('seam', 'seam.left', seam, 6, ROWS.seam);
      ask('seam', 'seam.right', seam, width - 6 - w, ROWS.seam);
    }
    const behind = messages.format('guides.behind');
    const behindWidth = Math.ceil(g.measureText(behind).width);
    measured.behind.forEach(([a, b], i) => {
      // Only where the span holds it.
      if (behindWidth <= b - a - 12) {
        ask('behind', `behind.${String(i)}`, behind, (a + b) / 2 - behindWidth / 2, ROWS.behind);
      }
    });
    const facing = this.#facingText(measured.facing);
    if (measured.facing !== null && facing !== null) {
      const w = Math.ceil(g.measureText(facing).width);
      ask('facing', 'facing', facing, measured.facing.x - w / 2, ROWS.heading);
    }
    for (const line of measured.headings) {
      if (line.degrees % GRID.major !== 0) {
        continue;
      }
      const top = line.runs
        .flat()
        .filter(([x]) => x >= 0 && x <= width)
        .sort((p, q) => p[1] - q[1])[0];
      if (top === undefined) {
        continue;
      }
      const text = messages.format('radar.bearing', { value: line.degrees });
      const w = Math.ceil(g.measureText(text).width);
      ask('heading', `heading.${String(line.degrees)}`, text, top[0] - w / 2, ROWS.heading);
    }
    // The windows are drawn over the guides: a word keeps clear of every window's frame and mark,
    // and of every place the window's name may be written, as the panorama last presented them.
    // Either backend draws a frame within the box the geometry backend draws it in: through its
    // corners, which the geometry backend's outline passes through.
    const windows: NameObstacle[] = [];
    const presented = this.#options.app.viewport.lastFrame();
    if (presented !== null) {
      const { app } = this.#options;
      const shown = presented.frame.view;
      const module = app.projections.get(shown.projectionId);
      if (module === undefined) {
        throw new Error(`projection "${shown.projectionId}" is not registered`);
      }
      const frames = windowFrames(presented.frame, projectionFor(module, shown));
      const names = windowNames(
        presented.frame,
        (text) => [
          Math.ceil(g.measureText(text).width) + 2 * NAME_PLATE.margin,
          NAME_PLATE.line + 2 * NAME_PLATE.margin,
        ],
        new Map([...frames].map(([nodeId, drawn]) => [nodeId, drawn.box])),
      );
      for (const { box } of names.obstacles) {
        windows.push({ owner: WINDOWS, box });
      }
      for (const name of names.names) {
        for (const [x, y] of name.places) {
          windows.push({ owner: WINDOWS, box: [x, y, name.size[0], name.size[1]] });
        }
      }
    }
    const placed = placeNames({ width, height }, windows, requests);
    return requests.flatMap((request, i) => {
      const at = placed[i];
      return at === null || at === undefined
        ? []
        : [{ kind: request.kind, text: request.text, at, size: request.size }];
    });
  }
}

/** A heading in radians as the radar writes it: whole degrees to the right, from -179 to 180. */
function bearingOf(heading: number): number {
  const degrees = Math.round((heading * 180) / Math.PI);
  return degrees - 360 * Math.ceil((degrees - 180) / 360);
}

/** Strokes each run of points as one line. */
function stroke(g: CanvasRenderingContext2D, runs: readonly (readonly ScreenPoint[])[]): void {
  for (const run of runs) {
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

function set(element: HTMLElement, properties: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(properties)) {
    element.style.setProperty(name, value);
  }
}
