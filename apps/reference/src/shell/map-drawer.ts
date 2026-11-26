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
/** Room for a window's name beside its dot, in CSS pixels. */
const LABEL = Object.freeze({ width: 132, height: 30, gap: 8 });

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

export interface MapDrawerOptions {
  /** Default `map`. */
  readonly kind?: MapKind;
  readonly app: ReferenceApp;
  readonly messages: Messages;
  readonly viewport: HTMLElement;
  readonly canvas: HTMLCanvasElement;
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
   * The names laid over the drawing: the two halves of the ground first, beside the camera, then
   * the selected and focused windows', then the nearest to the camera, each only where it
   * overlaps no name already placed.
   */
  #units(scene: MapScene, view: MapView): StageUnit[] {
    const units: StageUnit[] = [];
    const placed: { x: number; y: number }[] = [];
    const free = (x: number, y: number) =>
      placed.every((p) => Math.abs(p.x - x) >= LABEL.width || Math.abs(p.y - y) >= LABEL.height);
    const order = [...scene.markers].sort(
      (a, b) =>
        Number(b.selected || b.focused) - Number(a.selected || a.focused) ||
        a.distance - b.distance ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const { messages } = this.#options;
    const [cx, cy] = toMap(view, scene.camera.x, scene.camera.z);
    const ahead: [number, number] = [
      Math.sin(scene.camera.heading),
      -Math.cos(scene.camera.heading),
    ];
    const reading = (key: string, title: string, x: number, y: number) => {
      placed.push({ x, y });
      units.push({
        key,
        title,
        x,
        y,
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
    if (this.#kind === 'radar') {
      // Each ring's distance, down the line straight behind as the scene was made; each bearing,
      // at the rim.
      const reach = radarReach(scene);
      const step = ringStep(reach);
      for (let r = step; r <= reach + 1e-9; r += step) {
        const value = Number(r.toFixed(2));
        reading(
          `ring.${String(value)}`,
          messages.format('radar.ring', { value }),
          cx + 3,
          cy + r * view.scale - READING.height + 4,
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
        reading(`bearing.${String(degrees)}`, title, x, y);
      }
    }
    for (const [key, sign, label] of this.#kind === 'radar'
      ? []
      : ([
          ['region.front', 1, messages.format('map.front')],
          ['region.behind', -1, messages.format('map.behind')],
        ] as const)) {
      const x = cx + sign * ahead[0] * 48 - LABEL.width / 2;
      const y = cy + sign * ahead[1] * 48 - LABEL.height / 2;
      placed.push({ x, y });
      units.push({
        key,
        title: label,
        x,
        y,
        width: LABEL.width,
        height: LABEL.height,
        scale: 1,
        depth: 0,
        container: false,
        band: 0,
        emphasis: 'quiet',
        titled: true,
        open: false,
        interactive: false,
      });
    }
    for (const marker of order) {
      const [mx, my] = toMap(view, marker.x, marker.z);
      const x = mx + LABEL.gap;
      const y = my - LABEL.height / 2;
      if (x > view.width || y > view.height || x + LABEL.width < 0 || y + LABEL.height < 0) {
        continue;
      }
      // On the radar, only the selected and the focused window are named: it is small.
      const titled = marker.selected || marker.focused || (this.#kind === 'map' && free(x, y));
      if (titled) {
        placed.push({ x, y });
      }
      units.push({
        key: marker.id,
        title: marker.label,
        x,
        y,
        width: LABEL.width,
        height: LABEL.height,
        scale: 1,
        depth: marker.selected ? 3 : marker.focused ? 2 : 1,
        container: false,
        band: 0,
        emphasis: marker.selected ? 'prominent' : marker.side === 'behind' ? 'quiet' : undefined,
        titled,
        open: false,
        interactive: false,
      });
    }
    return units;
  }
}
