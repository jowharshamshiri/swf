import type { SurfaceAdapter, SurfaceCapabilities } from '@swf/surfaces';
import { ADAPTER_API_VERSION } from '@swf/surfaces';
import type { Messages } from './messages.js';
import type { PlannedWindow, PresetId, WindowDetail } from './presets.js';
import { NOTE_ADAPTER, planPreset, plannedByKey, TILE_ADAPTER } from './presets.js';

/**
 * The demo content the reference application hosts: what its windows present. The scene refers to
 * it only by binding key; the application, as the host, keeps the content and hands it to the
 * framework through two adapters registered like any host's. A key names a preset, a seed and a
 * window, so the host finds the content of any key a preset plans, in any session: a layout saved
 * yesterday binds again today. A note is a native page element
 * with text the operator can select and edit, presented live; a tile is drawn on a canvas, which
 * the geometry backend warps into the panorama.
 */

const NOTE_CAPABILITIES: SurfaceCapabilities = Object.freeze({
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

const TILE_CAPABILITIES: SurfaceCapabilities = Object.freeze({
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

/** A note's endpoint: its element, made once and moved only by the framework's attachment. */
export interface NoteHandle {
  readonly key: string;
  readonly element: HTMLElement;
}

/** A tile's endpoint: a drawable as the geometry backend takes it. */
export interface TileHandle {
  readonly key: string;
  readonly source: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly revision: number;
}

/** Tiles are drawn at this many pixels per world unit. */
const TILE_PIXELS = 240;

/**
 * A described window's tile: its category over its name, its headline figure large, and a row of
 * bars under it, each bar's height made from the window's hue, so every tile draws the same way.
 */
function drawDetail(
  ctx: CanvasRenderingContext2D,
  window: PlannedWindow,
  detail: WindowDetail,
  width: number,
  height: number,
): void {
  const line = (size: number, weight: string) =>
    `${weight} ${String(Math.round(size))}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  const left = width * 0.06;
  ctx.font = line(height / 11, '600');
  ctx.fillText(detail.category.toUpperCase(), left, height * 0.12, width * 0.88);
  ctx.font = line(height / 7, '600');
  ctx.fillText(window.label, left, height * 0.27, width * 0.88);
  ctx.font = line(height / 4, '700');
  ctx.fillText(detail.metric, left, height * 0.5, width * 0.88);
  const bars = 12;
  const gap = width * 0.012;
  const span = (width * 0.88 - gap * (bars - 1)) / bars;
  ctx.fillStyle = `hsl(${String(window.hue)} 70% 78%)`;
  for (let i = 0; i < bars; i++) {
    const rise = (((window.hue * 7 + i * 37) % 61) + 25) / 100;
    const barHeight = height * 0.24 * rise;
    ctx.fillRect(left + i * (span + gap), height * 0.94 - barHeight, span, barHeight);
  }
}

export interface DemoContent {
  readonly notes: SurfaceAdapter<NoteHandle>;
  readonly tiles: SurfaceAdapter<TileHandle>;
  /** The window a binding key names, or null when it names none the host has. */
  find(key: string): PlannedWindow | null;
}

export function createDemoContent(document: Document, messages: Messages): DemoContent {
  // Plans asked for by keys, by preset and seed: this host's own, never shared.
  const plans = new Map<string, readonly PlannedWindow[]>();
  const plan = (preset: PresetId, seed: number): readonly PlannedWindow[] => {
    const id = `${preset}@${String(seed)}`;
    let windows = plans.get(id);
    if (windows === undefined) {
      windows = planPreset(preset, seed);
      plans.set(id, windows);
    }
    return windows;
  };
  const find = (key: string) => plannedByKey(key, plan);
  const notes = new Map<string, NoteHandle>();
  const tiles = new Map<string, TileHandle>();

  const makeNote = (window: PlannedWindow): NoteHandle => {
    const element = document.createElement('article');
    element.dataset['referenceContent'] = window.bindingKey;
    element.style.setProperty('box-sizing', 'border-box');
    element.style.setProperty('width', '100%');
    element.style.setProperty('height', '100%');
    element.style.setProperty('margin', '0');
    element.style.setProperty('padding', '8px 12px');
    element.style.setProperty('overflow', 'hidden');
    element.style.setProperty('background', `hsl(${String(window.hue)} 45% 92%)`);
    element.style.setProperty('color', `hsl(${String(window.hue)} 40% 18%)`);
    element.style.setProperty('font', '18px/1.3 system-ui, sans-serif');
    const detail = window.detail;
    if (detail !== undefined) {
      const category = document.createElement('p');
      category.style.setProperty('margin', '0');
      category.style.setProperty('font-size', '13px');
      category.style.setProperty('font-weight', '600');
      category.style.setProperty('letter-spacing', '0.06em');
      category.style.setProperty('text-transform', 'uppercase');
      category.style.setProperty('opacity', '0.7');
      category.textContent = detail.category;
      element.append(category);
    }
    const title = document.createElement('h2');
    title.style.setProperty('margin', '0 0 6px');
    title.style.setProperty('font-size', '22px');
    title.textContent = window.label;
    element.append(title);
    if (detail !== undefined) {
      const metric = document.createElement('p');
      metric.style.setProperty('margin', '0 0 4px');
      metric.style.setProperty('font-size', '30px');
      metric.style.setProperty('font-weight', '700');
      metric.textContent = detail.metric;
      element.append(metric);
    }
    const body = document.createElement('p');
    body.style.setProperty('margin', '0');
    body.contentEditable = 'plaintext-only';
    body.spellcheck = false;
    body.textContent = detail?.description ?? messages.format('content.note.body');
    element.append(body);
    return { key: window.bindingKey, element };
  };

  const makeTile = (window: PlannedWindow): TileHandle => {
    const width = Math.max(1, Math.round((window.width - 0.16) * TILE_PIXELS));
    const height = Math.max(1, Math.round((window.height - 0.28) * TILE_PIXELS));
    const source = document.createElement('canvas');
    source.width = width;
    source.height = height;
    const ctx = source.getContext('2d');
    if (ctx !== null) {
      const hue = String(window.hue);
      ctx.fillStyle = `hsl(${hue} 55% 38%)`;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = `hsl(${hue} 60% 60%)`;
      ctx.lineWidth = 1;
      for (let x = 0; x <= width; x += 24) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
      }
      for (let y = 0; y <= height; y += 24) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const detail = window.detail;
      if (detail === undefined) {
        ctx.font = `600 ${String(Math.round(height / 5))}px system-ui, sans-serif`;
        ctx.fillText(window.label, width / 2, height / 2, width * 0.9);
        ctx.font = `${String(Math.round(height / 10))}px system-ui, sans-serif`;
        ctx.fillText(
          messages.format('content.tile.caption'),
          width / 2,
          height * 0.72,
          width * 0.9,
        );
      } else {
        drawDetail(ctx, window, detail, width, height);
      }
    }
    return { key: window.bindingKey, source, width, height, revision: 1 };
  };

  /** Content is made on its first request and kept from then on. */
  const resolver =
    <T>(kind: PlannedWindow['content'], cache: Map<string, T>, make: (w: PlannedWindow) => T) =>
    (key: string, signal: AbortSignal): Promise<T | null> => {
      if (signal.aborted) {
        return Promise.reject(signal.reason as Error);
      }
      const window = find(key);
      if (window?.content !== kind) {
        return Promise.resolve(null);
      }
      const existing = cache.get(key);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      const made = make(window);
      cache.set(key, made);
      return Promise.resolve(made);
    };

  const containerOf = (container: unknown): HTMLElement => {
    if (!(container instanceof HTMLElement)) {
      throw new Error('a note can only be attached to an element');
    }
    return container;
  };

  const noteAdapter: SurfaceAdapter<NoteHandle> = Object.freeze({
    id: NOTE_ADAPTER,
    apiVersion: ADAPTER_API_VERSION,
    declaredCapabilities: NOTE_CAPABILITIES,
    resolve: resolver('note', notes, makeNote),
    capabilities: () => NOTE_CAPABILITIES,
    attach(handle: NoteHandle, target: { container: unknown }) {
      containerOf(target.container).append(handle.element);
    },
    update: () => undefined,
    detach(handle: NoteHandle) {
      handle.element.remove();
    },
  });

  const tileAdapter: SurfaceAdapter<TileHandle> = Object.freeze({
    id: TILE_ADAPTER,
    apiVersion: ADAPTER_API_VERSION,
    declaredCapabilities: TILE_CAPABILITIES,
    resolve: resolver('tile', tiles, makeTile),
    capabilities: () => TILE_CAPABILITIES,
    // A tile is drawn by the geometry backend from its handle: nothing is mounted.
    attach: () => undefined,
    update: () => undefined,
    detach: () => undefined,
  });

  return Object.freeze({
    notes: noteAdapter,
    tiles: tileAdapter,
    find,
  });
}
