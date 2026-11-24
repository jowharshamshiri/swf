import type { SurfaceAdapter, SurfaceCapabilities } from '@swf/surfaces';
import { ADAPTER_API_VERSION } from '@swf/surfaces';
import type { Messages } from './messages.js';
import type { PlannedWindow } from './presets.js';
import { NOTE_ADAPTER, TILE_ADAPTER } from './presets.js';

/**
 * The demo content the reference application hosts: what its windows present. The scene refers to
 * it only by binding key; the application, as the host, keeps the content and hands it to the
 * framework through two adapters registered like any host's. A note is a native page element
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

export interface DemoContent {
  readonly notes: SurfaceAdapter<NoteHandle>;
  readonly tiles: SurfaceAdapter<TileHandle>;
  /**
   * Makes the content these windows show available. Content stays available once added, so a
   * scene brought back by undo finds its content again.
   */
  add(windows: readonly PlannedWindow[]): void;
  /** Whether a binding key names content the host has. */
  has(key: string): boolean;
}

export function createDemoContent(document: Document, messages: Messages): DemoContent {
  const planned = new Map<string, PlannedWindow>();
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
    const title = document.createElement('h2');
    title.style.setProperty('margin', '0 0 6px');
    title.style.setProperty('font-size', '22px');
    title.textContent = window.label;
    const body = document.createElement('p');
    body.style.setProperty('margin', '0');
    body.contentEditable = 'plaintext-only';
    body.spellcheck = false;
    body.textContent = messages.format('content.note.body');
    element.append(title, body);
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
      ctx.font = `600 ${String(Math.round(height / 5))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(window.label, width / 2, height / 2, width * 0.9);
      ctx.font = `${String(Math.round(height / 10))}px system-ui, sans-serif`;
      ctx.fillText(messages.format('content.tile.caption'), width / 2, height * 0.72, width * 0.9);
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
      const window = planned.get(key);
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
    add(windows: readonly PlannedWindow[]) {
      for (const window of windows) {
        planned.set(window.bindingKey, window);
      }
    },
    has: (key: string) => planned.has(key),
  });
}
