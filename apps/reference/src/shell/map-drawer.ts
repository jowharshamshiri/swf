import type { StageUnit } from '@wsb/uikit/components';
import { resolvePalette } from '@wsb/uikit/primitives';
import type { ReferenceApp } from '../app.js';
import { VIEWPORT_ID } from '../app.js';
import type { MapScene, MapView } from '../map.js';
import { MAP_SCALE, mapScene, MarkerDrag, markerAt, toGround, toMap, zoomed } from '../map.js';
import type { Messages } from '../messages.js';

/**
 * Draws the map on the kit's stage and works it: the ground split into what lies in front of the
 * camera and what lies behind, rings a world unit apart round the camera, the camera with its
 * heading, and each window as the line it stands on from above with a dot at its centre (filled
 * in front, hollow behind). Window names are the stage's units, real text over the drawing.
 *
 * A press on a window selects it, and dragging it moves the window on the ground: previewed on
 * every move, so every view shows it where it is being put, and committed once when it is let go
 * (Escape puts it back). A press on the ground pans the map; the wheel zooms it about the pointer.
 * The map's centre and scale are its own view state, never the scene's.
 */

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
  camera: 'button.background',
});
type Inks = { readonly [K in keyof typeof INKS]: string };

export interface MapDrawerOptions {
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
  #inks: Inks;
  #drag: { readonly marker: MarkerDrag; moved: boolean; readonly pointer: number } | null = null;
  #pan: { readonly pointer: number; x: number; y: number } | null = null;
  #frame: number | null = null;
  readonly #stops: (() => void)[] = [];

  constructor(options: MapDrawerOptions) {
    this.#options = options;
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
        event.preventDefault();
        const [x, y] = this.#local(event);
        this.#setView(zoomed(this.#view, Math.pow(MAP_SCALE.step, -event.deltaY / 100), x, y));
      },
      { passive: false },
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.#drag !== null) {
        event.preventDefault();
        this.#drag.marker.cancel();
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
    this.#drag?.marker.cancel();
    this.#drag = null;
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
      rule: ink(INKS.rule),
      quiet: ink(INKS.quiet),
      ink: ink(INKS.ink),
      accent: ink(INKS.accent),
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
    const marker = markerAt(this.#view, this.#scene(), x, y, REACH);
    this.#options.viewport.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (marker === null) {
      this.#pan = { pointer: event.pointerId, x, y };
      return;
    }
    this.#options.onselect(marker.id);
    this.#drag = {
      marker: new MarkerDrag(this.#options.app.workspace, VIEWPORT_ID, marker.id),
      moved: false,
      pointer: event.pointerId,
    };
  }

  #move(event: PointerEvent): void {
    const [x, y] = this.#local(event);
    if (this.#drag?.pointer === event.pointerId) {
      const [gx, gz] = toGround(this.#view, x, y);
      if (this.#drag.marker.moveTo(gx, gz)) {
        this.#drag.moved = true;
      }
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
        marker.cancel();
      } else {
        marker.commit();
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
    const view = this.#view;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.fillStyle = ink.ground;
    g.fillRect(0, 0, width, height);

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

    // Rings a world unit apart round the camera, as far as the map shows.
    const reach =
      Math.hypot(width, height) / view.scale +
      Math.hypot(view.centre[0] - scene.camera.x, view.centre[1] - scene.camera.z);
    const every = view.scale < 20 ? 5 : 1;
    for (let r = every; r <= reach; r += every) {
      g.beginPath();
      g.arc(cx, cy, r * view.scale, 0, 2 * Math.PI);
      g.stroke();
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
      g.globalAlpha = marker.visible ? 1 : 0.45;
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
        g.fillStyle = ink.behind;
        g.fill();
        g.lineWidth = 2;
        g.stroke();
      }
      if (marker.focused) {
        g.strokeStyle = ink.accent;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(mx, my, 10, 0, 2 * Math.PI);
        g.stroke();
      }
      g.globalAlpha = 1;
    }
    this.#options.onunits(this.#units(scene));
  }

  /**
   * The names laid over the drawing: the two halves of the ground first, beside the camera, then
   * the selected and focused windows', then the nearest to the camera, each only where it
   * overlaps no name already placed.
   */
  #units(scene: MapScene): StageUnit[] {
    const view = this.#view;
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
    for (const [key, sign, label] of [
      ['region.front', 1, messages.format('map.front')],
      ['region.behind', -1, messages.format('map.behind')],
    ] as const) {
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
      const titled = marker.selected || marker.focused || free(x, y);
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
