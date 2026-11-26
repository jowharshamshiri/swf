import type { StageUnit } from '@wsb/uikit/components';
import { resolvePalette } from '@wsb/uikit/primitives';
import type { ReferenceApp } from '../app.js';
import { VIEWPORT_ID } from '../app.js';
import type { MapScene, MapView } from '../map.js';
import {
  inView,
  MAP_SCALE,
  mapScene,
  MarkerDrag,
  markerAt,
  radarReach,
  radarView,
  ringStep,
  toGround,
  toMap,
  zoomed,
} from '../map.js';
import type { Messages } from '../messages.js';
import { ringsOf } from '../features.js';
import { fieldOfViewOf } from '../modes.js';
import { models } from '@swf/models';

/**
 * Draws the map on the kit's stage and works it: the ground split into what lies in front of the
 * camera and what lies behind, the wedge the panorama shows (while it shows less than the whole
 * circle), rings round the camera, the camera with its heading, and each window as the line it
 * stands on from above with a dot at its centre (filled in front, hollow and dashed behind, faded
 * while the panorama does not show it, ringed while it is focused, in the selection's colour while
 * it is selected). Window names are the stage's units, real text over the drawing.
 *
 * A press on a window selects it, and dragging it (past the router's slop) moves the window on
 * the ground as far as the pointer moves, the point it was grabbed by staying under the pointer:
 * previewed on every move, so every view shows it where it is being put, and committed once when
 * it is let go (Escape puts it back). A press that does not drag moves nothing.
 *
 * Drawn as the map, a press on the ground pans it and the wheel zooms it about the pointer: its
 * centre and scale are its own view state, never the scene's. Drawn as the radar, it is always
 * centred on the camera and scaled to hold every window inside its rim, with the distance of each
 * ring and the bearing round the rim written on it; the ground takes no press and the wheel scrolls
 * what the radar is in. Its scale holds while a window is dragged, so the pointer keeps its place.
 */

/** A map the reader pans and zooms, or a radar that follows the camera. */
export type MapKind = 'map' | 'radar';

/** Room round the radar's rim for its bearings, in CSS pixels. */
export const RADAR_MARGIN = 24;
/** A bearing written round the radar's rim, and its tick. */
const BEARINGS = Object.freeze([0, 90, 180, -90]);
/** Room for a ring's distance or a bearing, in CSS pixels. */
const READING = Object.freeze({ width: 60, height: 22 });

/** How near a press must be to a window's dot to take it, in CSS pixels. */
const REACH = 12;
/** Room for a window's name beside its dot on the radar, and the gap between dot and name, in CSS pixels. */
const LABEL = Object.freeze({ width: 132, height: 30, gap: 8 });
/** How far inside the map's edges its front and behind are named, in CSS pixels. */
const EDGE = 8;
/** The least room between two rings' distances written on the map, in CSS pixels. */
const RING_ROOM = 100;

/** The palette colours the map is drawn in, by their VS Code names. */
const INKS = Object.freeze({
  ground: 'editorWidget.background',
  behind: 'input.background',
  rule: 'panel.border',
  quiet: 'descriptionForeground',
  ink: 'editor.foreground',
  accent: 'focusBorder',
  focused: 'editorWarning.foreground',
  camera: 'button.background',
});
type Inks = { readonly [K in keyof typeof INKS]: string };

/** A name or a reading as the drawer places it, before the stage is told of it. */
interface Label {
  readonly key: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly emphasis: 'quiet' | 'prominent' | undefined;
  readonly titled: boolean;
}

/** A name or a reading as the stage lays it over the drawing. */
function stageUnit(label: Label): StageUnit {
  return {
    key: label.key,
    title: label.title,
    x: label.x,
    y: label.y,
    width: label.width,
    height: label.height,
    scale: 1,
    depth: label.depth,
    container: false,
    band: 0,
    emphasis: label.emphasis,
    titled: label.titled,
    open: false,
    interactive: false,
  };
}

export interface MapDrawerOptions {
  /** Default `map`. */
  readonly kind?: MapKind;
  readonly app: ReferenceApp;
  readonly messages: Messages;
  readonly viewport: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** The stage's layer of units, where a name is measured before it is placed. */
  readonly layer: HTMLElement;
  /** The names to lay over the drawing, as the stage shows them. */
  readonly onunits: (units: StageUnit[]) => void;
  /** The map's view changed (its scale, for the scale's reading). */
  readonly onview: (view: MapView) => void;
  /** A press on a window: select it. */
  readonly onselect: (id: string) => void;
}

export class MapDrawer {
  #view: MapView;
  readonly #options: MapDrawerOptions;
  readonly #kind: MapKind;
  #inks: Inks;
  /**
   * A marker pressed: it becomes a drag (`marker`) once the pointer has moved past the router's
   * slop from where it pressed, so a press that only selects moves nothing.
   */
  #drag: {
    readonly nodeId: string;
    readonly pointer: number;
    readonly from: readonly [number, number];
    marker: MarkerDrag | null;
  } | null = null;
  #pan: { readonly pointer: number; x: number; y: number } | null = null;
  #frame: number | null = null;
  readonly #stops: (() => void)[] = [];
  /** Each name's size as the stage writes it, by its text, until the appearance changes. */
  #measured = new Map<string, { width: number; height: number }>();

  constructor(options: MapDrawerOptions) {
    this.#options = options;
    this.#kind = options.kind ?? 'map';
    const box = options.viewport.getBoundingClientRect();
    this.#view = { centre: [0, 0], scale: MAP_SCALE.initial, width: box.width, height: box.height };
    this.#inks = this.#readInks();
    const { viewport, app } = options;
    const document = viewport.ownerDocument;
    const window = document.defaultView;
    if (window === null) {
      throw new Error('the map is not in a window');
    }

    const resize = new ResizeObserver(() => {
      const next = viewport.getBoundingClientRect();
      this.#setView({ ...this.#view, width: next.width, height: next.height });
    });
    resize.observe(viewport);
    this.#stops.push(() => {
      resize.disconnect();
    });

    // The scene, and every preview of it, redraws the map.
    this.#stops.push(
      app.workspace.subscribe(() => {
        this.#schedule();
      }),
    );

    // An appearance or theme changes the palette.
    const appearance = new MutationObserver(() => {
      this.#inks = this.#readInks();
      this.#measured.clear();
      this.#schedule();
    });
    appearance.observe(document.documentElement, { attributes: true });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      this.#inks = this.#readInks();
      this.#measured.clear();
      this.#schedule();
    };
    scheme.addEventListener('change', onScheme);
    this.#stops.push(() => {
      appearance.disconnect();
      scheme.removeEventListener('change', onScheme);
    });

    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler, options);
      this.#stops.push(() => {
        target.removeEventListener(type, handler, options);
      });
    };
    listen(viewport, 'pointerdown', (event) => {
      this.#press(event);
    });
    listen(viewport, 'pointermove', (event) => {
      this.#move(event);
    });
    listen(viewport, 'pointerup', (event) => {
      this.#release(event, false);
    });
    listen(viewport, 'pointercancel', (event) => {
      this.#release(event, true);
    });
    listen(viewport, 'lostpointercapture', (event) => {
      this.#release(event, true);
    });
    listen(
      viewport,
      'wheel',
      (event) => {
        if (this.#kind === 'radar') {
          return;
        }
        event.preventDefault();
        const [x, y] = this.#local(event);
        this.#setView(zoomed(this.#view, Math.pow(MAP_SCALE.step, -event.deltaY / 100), x, y));
      },
      { passive: false },
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.#drag !== null) {
        event.preventDefault();
        this.#drag.marker?.cancel();
        this.#drag = null;
      }
    };
    window.addEventListener('keydown', onKey);
    this.#stops.push(() => {
      window.removeEventListener('keydown', onKey);
    });
    this.#schedule();
  }

  get view(): MapView {
    return this.#view;
  }

  /** Zooms about the map's centre. */
  zoomBy(factor: number): void {
    this.#setView(zoomed(this.#view, factor, this.#view.width / 2, this.#view.height / 2));
  }

  /** Centres the map on a ground point. */
  centreOn(x: number, z: number): void {
    this.#setView({ ...this.#view, centre: [x, z] });
  }

  /** Centres the map on a window, if it is in the scene. */
  centreOnWindow(id: string): void {
    const marker = this.#scene().markers.find((m) => m.id === id);
    if (marker !== undefined) {
      this.centreOn(marker.x, marker.z);
    }
  }

  dispose(): void {
    this.#drag?.marker?.cancel();
    this.#drag = null;
    if (this.#frame !== null) {
      this.#options.viewport.ownerDocument.defaultView?.cancelAnimationFrame(this.#frame);
    }
    for (const stop of this.#stops.splice(0)) {
      stop();
    }
  }

  /** The view the drawing is laid out in now: the radar's follows the camera and fits the scene. */
  #laidOut(scene: MapScene): MapView {
    if (this.#kind === 'map' || this.#drag?.marker != null) {
      return this.#view;
    }
    const { width, height } = this.#view;
    this.#view = radarView(scene, width, height, RADAR_MARGIN);
    return this.#view;
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
      rule: ink(INKS.rule),
      quiet: ink(INKS.quiet),
      ink: ink(INKS.ink),
      accent: ink(INKS.accent),
      focused: ink(INKS.focused),
      camera: ink(INKS.camera),
    };
  }

  /** The scene as every view shows it now: open previews included. */
  #scene(): MapScene {
    return mapScene(this.#options.app.workspace.getPresented(), VIEWPORT_ID);
  }

  #setView(view: MapView): void {
    this.#view = view;
    this.#options.onview(view);
    this.#schedule();
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

  #press(event: PointerEvent): void {
    if ((event.pointerType === 'mouse' && event.button !== 0) || this.#drag !== null) {
      return;
    }
    const [x, y] = this.#local(event);
    const scene = this.#scene();
    const marker = markerAt(this.#laidOut(scene), scene, x, y, REACH);
    if (marker === null) {
      // The radar's ground takes no press: it always shows the camera at its centre.
      if (this.#kind === 'map') {
        this.#options.viewport.setPointerCapture(event.pointerId);
        event.preventDefault();
        this.#pan = { pointer: event.pointerId, x, y };
      }
      return;
    }
    this.#options.viewport.setPointerCapture(event.pointerId);
    event.preventDefault();
    this.#options.onselect(marker.id);
    this.#drag = { nodeId: marker.id, pointer: event.pointerId, from: [x, y], marker: null };
  }

  #move(event: PointerEvent): void {
    const [x, y] = this.#local(event);
    const drag = this.#drag;
    if (drag?.pointer === event.pointerId) {
      if (drag.marker === null) {
        const { slopPx } = this.#options.app.router.settings();
        if (Math.hypot(x - drag.from[0], y - drag.from[1]) <= slopPx) {
          return;
        }
        const { policies } = this.#options.app;
        drag.marker = new MarkerDrag(
          this.#options.app.workspace,
          VIEWPORT_ID,
          drag.nodeId,
          toGround(this.#view, drag.from[0], drag.from[1]),
          () => {
            const features = policies.status().features;
            return features.enabled.snap
              ? { settings: features.snap, rings: ringsOf(features.depth) }
              : null;
          },
        );
      }
      const [gx, gz] = toGround(this.#view, x, y);
      drag.marker.moveTo(gx, gz);
      return;
    }
    if (this.#pan?.pointer === event.pointerId) {
      const { scale, centre } = this.#view;
      const dx = (x - this.#pan.x) / scale;
      const dz = (y - this.#pan.y) / scale;
      this.#pan = { ...this.#pan, x, y };
      this.#setView({ ...this.#view, centre: [centre[0] - dx, centre[1] - dz] });
    }
  }

  #release(event: PointerEvent, cancelled: boolean): void {
    if (this.#drag?.pointer === event.pointerId) {
      const { marker } = this.#drag;
      this.#drag = null;
      if (cancelled) {
        marker?.cancel();
      } else {
        marker?.commit();
      }
    }
    if (this.#pan?.pointer === event.pointerId) {
      this.#pan = null;
    }
  }

  #draw(): void {
    const { canvas } = this.#options;
    const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const { width, height } = this.#view;
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
      throw new Error('the map has no 2D drawing context');
    }
    const ink = this.#inks;
    const scene = this.#scene();
    const view = this.#laidOut(scene);
    const { app } = this.#options;
    const presented = app.workspace.getPresented();
    const shown = new Set(
      scene.markers
        .filter((marker) => inView(presented, VIEWPORT_ID, app.projections, marker.id))
        .map((marker) => marker.id),
    );
    const projection = presented.viewports.get(VIEWPORT_ID)?.projection;
    const fieldOfView = projection === undefined ? 360 : fieldOfViewOf(projection);
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.fillStyle = ink.ground;
    g.fillRect(0, 0, width, height);
    g.save();
    if (this.#kind === 'radar') {
      // The radar is a disc: nothing it draws reaches past its rim.
      const [rx, ry] = toMap(view, scene.camera.x, scene.camera.z);
      g.beginPath();
      g.arc(rx, ry, radarReach(scene) * view.scale + 1, 0, 2 * Math.PI);
      g.clip();
    }

    // Behind the camera: the half-plane on the far side of the line through it, square to its
    // heading.
    const [cx, cy] = toMap(view, scene.camera.x, scene.camera.z);
    const ahead: [number, number] = [
      Math.sin(scene.camera.heading),
      -Math.cos(scene.camera.heading),
    ];
    const across: [number, number] = [-ahead[1], ahead[0]];
    const far = 4 * (width + height);
    g.fillStyle = ink.behind;
    g.beginPath();
    g.moveTo(cx + across[0] * far, cy + across[1] * far);
    g.lineTo(cx + across[0] * far - ahead[0] * far, cy + across[1] * far - ahead[1] * far);
    g.lineTo(cx - across[0] * far - ahead[0] * far, cy - across[1] * far - ahead[1] * far);
    g.lineTo(cx - across[0] * far, cy - across[1] * far);
    g.closePath();
    g.fill();
    g.strokeStyle = ink.rule;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx + across[0] * far, cy + across[1] * far);
    g.lineTo(cx - across[0] * far, cy - across[1] * far);
    g.stroke();

    // What the panorama shows: a wedge about the heading, while it shows less than the circle.
    if (fieldOfView < 360) {
      const half = (fieldOfView * Math.PI) / 360;
      // The canvas measures angles clockwise from +X; a heading, clockwise from up.
      const start = scene.camera.heading - half - Math.PI / 2;
      g.globalAlpha = 0.16;
      g.fillStyle = ink.accent;
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, far, start, start + 2 * half);
      g.closePath();
      g.fill();
      g.globalAlpha = 0.7;
      g.strokeStyle = ink.accent;
      g.beginPath();
      g.moveTo(cx + Math.cos(start) * far, cy + Math.sin(start) * far);
      g.lineTo(cx, cy);
      g.lineTo(cx + Math.cos(start + 2 * half) * far, cy + Math.sin(start + 2 * half) * far);
      g.stroke();
      g.globalAlpha = 1;
      g.strokeStyle = ink.rule;
    }

    // Rings round the camera: a world unit apart as far as the map shows, or the radar's own.
    if (this.#kind === 'radar') {
      const reach = radarReach(scene);
      const step = ringStep(reach);
      for (let r = step; r <= reach + 1e-9; r += step) {
        g.beginPath();
        g.arc(cx, cy, r * view.scale, 0, 2 * Math.PI);
        g.stroke();
      }
      // The bearings round the rim, a tick at each.
      const rim = reach * view.scale;
      g.strokeStyle = ink.quiet;
      for (let degrees = 0; degrees < 360; degrees += 30) {
        const a = (degrees * Math.PI) / 180;
        const inner = rim - (degrees % 90 === 0 ? 8 : 4);
        g.beginPath();
        g.moveTo(cx + Math.sin(a) * inner, cy - Math.cos(a) * inner);
        g.lineTo(cx + Math.sin(a) * rim, cy - Math.cos(a) * rim);
        g.stroke();
      }
    } else {
      const reach =
        Math.hypot(width, height) / view.scale +
        Math.hypot(view.centre[0] - scene.camera.x, view.centre[1] - scene.camera.z);
      const every = view.scale < 20 ? 5 : 1;
      for (let r = every; r <= reach; r += every) {
        g.beginPath();
        g.arc(cx, cy, r * view.scale, 0, 2 * Math.PI);
        g.stroke();
      }
    }

    // The camera, and its heading.
    g.fillStyle = ink.camera;
    g.beginPath();
    g.moveTo(cx + ahead[0] * 18, cy + ahead[1] * 18);
    g.lineTo(cx + across[0] * 7 - ahead[0] * 4, cy + across[1] * 7 - ahead[1] * 4);
    g.lineTo(cx - across[0] * 7 - ahead[0] * 4, cy - across[1] * 7 - ahead[1] * 4);
    g.closePath();
    g.fill();

    // A part and the window it came from, linked by a dashed line under both.
    const byId = new Map(scene.markers.map((marker) => [marker.id, marker]));
    g.strokeStyle = ink.accent;
    g.lineWidth = 1.5;
    g.setLineDash([5, 4]);
    g.globalAlpha = 0.8;
    for (const marker of scene.markers) {
      const origin = marker.partOf === null ? undefined : byId.get(marker.partOf);
      if (origin !== undefined) {
        const [px, py] = toMap(view, marker.x, marker.z);
        const [ox, oy] = toMap(view, origin.x, origin.z);
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(ox, oy);
        g.stroke();
      }
    }
    g.setLineDash([]);
    g.globalAlpha = 1;

    // Windows: the line each stands on, and its centre.
    const order = [...scene.markers].sort(
      (a, b) => Number(a.selected) - Number(b.selected) || b.distance - a.distance,
    );
    for (const marker of order) {
      const [mx, my] = toMap(view, marker.x, marker.z);
      const [a, b] = marker.ends;
      const [ax, ay] = toMap(view, a[0], a[1]);
      const [bx, by] = toMap(view, b[0], b[1]);
      const colour = marker.selected ? ink.accent : marker.side === 'front' ? ink.ink : ink.quiet;
      g.globalAlpha = marker.visible && shown.has(marker.id) ? 1 : 0.4;
      g.strokeStyle = colour;
      g.lineWidth = marker.selected ? 4 : 3;
      g.setLineDash(marker.side === 'behind' ? [4, 3] : []);
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.arc(mx, my, marker.selected ? 6 : 5, 0, 2 * Math.PI);
      if (marker.side === 'front') {
        g.fillStyle = colour;
        g.fill();
      } else {
        // Hollow: its middle is the ground behind the camera, however faded its ring.
        const alpha = g.globalAlpha;
        g.globalAlpha = 1;
        g.fillStyle = ink.behind;
        g.fill();
        g.globalAlpha = alpha;
        g.lineWidth = 2;
        g.stroke();
      }
      // Focus is never faded: the window keys act on is always seen.
      g.globalAlpha = 1;
      if (marker.focused) {
        g.strokeStyle = ink.focused;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(mx, my, 10, 0, 2 * Math.PI);
        g.stroke();
      }
    }
    g.restore();
    this.#options.onunits(this.#units(scene, view));
  }

  /**
   * A name's size as the stage writes it, in CSS pixels: measured once, by writing it as a unit
   * is written, out of sight in the stage's layer.
   */
  #measure(title: string): { width: number; height: number } {
    const known = this.#measured.get(title);
    if (known !== undefined) {
      return known;
    }
    const { layer } = this.#options;
    const document = layer.ownerDocument;
    const unit = document.createElement('article');
    unit.className = 'wsb-stage__unit wsb-stage__unit--titled';
    unit.style.setProperty('visibility', 'hidden');
    unit.style.setProperty('width', 'max-content');
    const head = document.createElement('header');
    head.className = 'wsb-stage__unit-title';
    head.textContent = title;
    unit.append(head);
    layer.append(unit);
    try {
      const box = head.getBoundingClientRect();
      const size = { width: Math.ceil(box.width) + 1, height: Math.ceil(box.height) };
      this.#measured.set(title, size);
      return size;
    } finally {
      unit.remove();
    }
  }

  /**
   * The names laid over the drawing. On the radar: each ring's distance and the bearings round its
   * rim, then the selected and the focused windows' names alone. On the map: the selected and the
   * focused windows' names, each written whatever it overlaps; every other window's name, nearest
   * the camera first; in front and behind, where the ground's halves meet the map's edges (or
   * beside that point along the edge); and each fifth ring's distance. Each is written where it
   * overlaps nothing written before it (the overview model's `labelsShown`), its box the size the
   * stage writes it, so a window's name is dropped only where another window's name is.
   */
  #units(scene: MapScene, view: MapView): StageUnit[] {
    const { messages } = this.#options;
    const [cx, cy] = toMap(view, scene.camera.x, scene.camera.z);
    const ahead: [number, number] = [
      Math.sin(scene.camera.heading),
      -Math.cos(scene.camera.heading),
    ];
    const unit = (
      key: string,
      title: string,
      x: number,
      y: number,
      size: { readonly width: number; readonly height: number },
      look: Partial<Pick<Label, 'depth' | 'emphasis' | 'titled'>> = {},
    ): Label => ({
      key,
      title,
      x,
      y,
      width: size.width,
      height: size.height,
      depth: look.depth ?? 0,
      emphasis: 'emphasis' in look ? look.emphasis : 'quiet',
      titled: look.titled ?? true,
    });
    const order = [...scene.markers].sort(
      (a, b) =>
        Number(b.selected || b.focused) - Number(a.selected || a.focused) ||
        a.distance - b.distance ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const onScreen = (x: number, y: number, size: { width: number; height: number }) =>
      x <= view.width && y <= view.height && x + size.width >= 0 && y + size.height >= 0;

    if (this.#kind === 'radar') {
      const units: Label[] = [];
      // Each ring's distance, down the line straight behind as the scene was made; each bearing,
      // at the rim.
      const reach = radarReach(scene);
      const step = ringStep(reach);
      for (let r = step; r <= reach + 1e-9; r += step) {
        const value = Number(r.toFixed(2));
        units.push(
          unit(
            `ring.${String(value)}`,
            messages.format('radar.ring', { value }),
            cx + 3,
            cy + r * view.scale - READING.height + 4,
            READING,
          ),
        );
      }
      // Straight ahead and behind outside the rim; the sides just inside it, above their ticks,
      // where a reading fits however narrow the radar is.
      const rim = reach * view.scale;
      for (const degrees of BEARINGS) {
        const title = messages.format('radar.bearing', { value: degrees });
        const side = degrees === 0 || degrees === 180 ? 0 : Math.sign(degrees);
        const [x, y] =
          side === 0
            ? [cx - READING.width / 2, degrees === 0 ? cy - rim - READING.height : cy + rim]
            : [side > 0 ? cx + rim - READING.width - 2 : cx - rim + 2, cy - READING.height - 2];
        units.push(unit(`bearing.${String(degrees)}`, title, x, y, READING));
      }
      // Only the selected and the focused window are named on the radar: it is small.
      for (const marker of order) {
        const [mx, my] = toMap(view, marker.x, marker.z);
        const x = mx + LABEL.gap;
        const y = my - LABEL.height / 2;
        if (!onScreen(x, y, LABEL)) {
          continue;
        }
        units.push(
          unit(marker.id, marker.label, x, y, LABEL, {
            depth: marker.selected ? 3 : marker.focused ? 2 : 1,
            emphasis: marker.selected
              ? 'prominent'
              : marker.side === 'behind'
                ? 'quiet'
                : undefined,
            titled: marker.selected || marker.focused,
          }),
        );
      }
      return units.map(stageUnit);
    }

    // Every place a name may be written, in the order weighed: the name it is a place for (the
    // places for one name share it), and whether it must be written.
    const candidates: { unit: Label; name: number; kept: boolean }[] = [];
    // A window's name to the right of its mark; where that runs off the map or onto another
    // name, to its left, above it or below it. One that must be written takes the first of those
    // that lies wholly on the map; a name with no such place keeps the first, partly off the map.
    const whole = (x: number, y: number, size: { width: number; height: number }) =>
      x >= 0 && y >= 0 && x + size.width <= view.width && y + size.height <= view.height;
    order.forEach((marker, i) => {
      const [mx, my] = toMap(view, marker.x, marker.z);
      const size = this.#measure(marker.label);
      const beside = my - size.height / 2;
      const centred = mx - size.width / 2;
      const offered: [number, number][] = [
        [mx + LABEL.gap, beside],
        [mx - LABEL.gap - size.width, beside],
        [centred, my - LABEL.gap - size.height],
        [centred, my + LABEL.gap],
      ];
      const places = offered.filter(([x, y]) => whole(x, y, size));
      const kept = marker.selected || marker.focused;
      const first = offered[0];
      if (first === undefined) {
        throw new Error('a name has nowhere to go');
      }
      for (const [x, y] of places.length === 0 ? [first] : kept ? places.slice(0, 1) : places) {
        candidates.push({
          unit: unit(marker.id, marker.label, x, y, size, {
            depth: marker.selected ? 3 : marker.focused ? 2 : 1,
            emphasis: marker.selected
              ? 'prominent'
              : marker.side === 'behind'
                ? 'quiet'
                : undefined,
          }),
          name: i,
          kept,
        });
      }
    });
    let next = order.length;
    // In front and behind: where the line through the camera along its heading meets the map's
    // edges (EDGE inside them), ahead of it and behind it, or beside that point along the edge
    // where a window's name is there already. A camera off the map names them at the edge nearest
    // that line, as far along it as the map's half diagonal.
    const inside = (x: number, y: number) =>
      x >= EDGE && x <= view.width - EDGE && y >= EDGE && y <= view.height - EDGE;
    const edgeAlong = (dx: number, dy: number): [number, number] => {
      if (inside(cx, cy)) {
        const limits = [
          dx > 0 ? (view.width - EDGE - cx) / dx : dx < 0 ? (EDGE - cx) / dx : Infinity,
          dy > 0 ? (view.height - EDGE - cy) / dy : dy < 0 ? (EDGE - cy) / dy : Infinity,
        ];
        const t = Math.min(...limits);
        return [cx + dx * t, cy + dy * t];
      }
      const far = Math.hypot(view.width, view.height) / 2;
      return [
        Math.min(view.width - EDGE, Math.max(EDGE, cx + dx * far)),
        Math.min(view.height - EDGE, Math.max(EDGE, cy + dy * far)),
      ];
    };
    for (const [key, sign, id] of [
      ['region.front', 1, 'map.front'],
      ['region.behind', -1, 'map.behind'],
    ] as const) {
      const title = messages.format(id);
      const size = this.#measure(title);
      const [ex, ey] = edgeAlong(sign * ahead[0], sign * ahead[1]);
      // On the top or bottom edge it moves across; on a side, up and down.
      const across = ey <= EDGE + 0.5 || ey >= view.height - EDGE - 0.5;
      const name = next++;
      for (const shift of [0, -1, 1, -2, 2]) {
        const x = across
          ? ex - size.width / 2 + shift * (size.width + LABEL.gap)
          : ex - size.width / 2;
        const y = across ? ey - size.height / 2 : ey - size.height / 2 + shift * (size.height + 2);
        // Wholly inside the map.
        candidates.push({
          unit: unit(
            key,
            title,
            Math.min(view.width - EDGE - size.width, Math.max(EDGE, x)),
            Math.min(view.height - EDGE - size.height, Math.max(EDGE, y)),
            size,
          ),
          name,
          kept: false,
        });
      }
    }
    // Rings' distances: on every ring, or every second, fifth or tenth, whichever first leaves
    // room between two readings; each down the line straight behind the camera, or where a name
    // is there, on the line to its right, to its left or ahead.
    const every = view.scale < 20 ? 5 : 1;
    const reach =
      Math.hypot(view.width, view.height) / view.scale +
      Math.hypot(view.centre[0] - scene.camera.x, view.centre[1] - scene.camera.z);
    const labelled = every * ([1, 2, 5, 10].find((n) => n * every * view.scale >= RING_ROOM) ?? 10);
    const across: [number, number] = [-ahead[1], ahead[0]];
    const lines: readonly [number, number][] = [
      [-ahead[0], -ahead[1]],
      across,
      [-across[0], -across[1]],
      ahead,
    ];
    for (let r = labelled; r <= reach; r += labelled) {
      const title = messages.format('map.ring', { value: r });
      const size = this.#measure(title);
      const name = next++;
      for (const [dx, dy] of lines) {
        const x = cx + dx * r * view.scale + 3;
        const y = cy + dy * r * view.scale - size.height;
        if (whole(x, y, size)) {
          candidates.push({
            unit: unit(`ring.${String(r)}`, title, x, y, size),
            name,
            kept: false,
          });
        }
      }
    }
    const visible = candidates.filter(({ unit: u }) => onScreen(u.x, u.y, u));
    const shown = models.labelsShown(
      visible.map(({ unit: u, name, kept }) => ({
        name: BigInt(name),
        x: BigInt(Math.round(u.x)),
        y: BigInt(Math.round(u.y)),
        width: BigInt(Math.ceil(u.width)),
        height: BigInt(Math.ceil(u.height)),
        kept,
      })),
    );
    if (shown.length !== visible.length) {
      throw new Error('the map was told about some of its names only');
    }
    // A window's name not written stays a unit, untitled, so it is written once it has room.
    // Each window's name where it is written; a window whose name is written nowhere keeps its
    // first place, untitled, so it is written once it has room. A reading not written, and a place
    // passed over, is no unit at all.
    const units: Label[] = [];
    const written = new Set<number>();
    visible.forEach(({ unit: u, name }, i) => {
      if (shown[i] === true) {
        units.push(u);
        written.add(name);
      }
    });
    const untitled = new Set<number>();
    for (const { unit: u, name } of visible) {
      if (name < order.length && !written.has(name) && !untitled.has(name)) {
        untitled.add(name);
        units.push({ ...u, titled: false });
      }
    }
    return units.map(stageUnit);
  }
}
