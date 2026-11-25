import { DOM_ATTRIBUTES } from './renderer.js';

/** The layer name a virtual cursor's element carries. */
export const VIRTUAL_CURSOR_LAYER = 'virtual-cursor';

/**
 * A cursor drawn inside a view, for an input policy that moves where input acts without moving the
 * platform's own pointer (which no page can move): a wrapped cursor, for one. It takes no input
 * and is hidden from assistive technology; whoever shows it says in words what it means.
 */
export interface VirtualCursor {
  /**
   * Shows the cursor with its tip at a point of the container, in CSS pixels from its top left.
   *
   * @throws `RangeError` for a point that is not finite; `Error` once the cursor is disposed.
   */
  show(x: number, y: number): void;
  /** Hides the cursor, keeping its element for the next `show`. */
  hide(): void;
  /** Where the cursor's tip is shown, or null while it is hidden; a frozen point. */
  position(): {
    /** CSS pixels from the container's left edge. */
    readonly x: number;
    /** CSS pixels from the container's top edge. */
    readonly y: number;
  } | null;
  /** Takes the cursor out of the container. Safe to call twice. */
  dispose(): void;
}

const SVG = 'http://www.w3.org/2000/svg';

/** An arrow, tip at the origin, as platforms draw their pointer: dark, outlined in light. */
const ARROW = 'M0.5 0.5 L0.5 17 L4.5 13 L7.5 20 L10.5 18.7 L7.6 12 L13 12 Z';

/**
 * Creates a virtual cursor in a view's container. It sits in a holder of no size at the
 * container's top left, so its coordinates are the container's whatever the container's own
 * positioning, and it never shifts what the container lays out. It starts hidden. The holder is
 * prepended to the container, which stays the caller's; the caller disposes the cursor to take
 * the holder out again.
 */
export function createVirtualCursor(options: { readonly container: HTMLElement }): VirtualCursor {
  const { container } = options;
  const document = container.ownerDocument;
  const holder = document.createElement('div');
  holder.setAttribute(DOM_ATTRIBUTES.layer, VIRTUAL_CURSOR_LAYER);
  holder.setAttribute('aria-hidden', 'true');
  set(holder, {
    position: 'relative',
    width: '0px',
    height: '0px',
    overflow: 'visible',
    'pointer-events': 'none',
  });
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '21');
  svg.setAttribute('viewBox', '0 0 14 21');
  set(svg as unknown as HTMLElement, {
    position: 'absolute',
    left: '0px',
    top: '0px',
    'z-index': '1',
    display: 'none',
    'pointer-events': 'none',
    overflow: 'visible',
  });
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ARROW);
  path.setAttribute('fill', 'rgb(20, 20, 20)');
  path.setAttribute('stroke', 'rgb(255, 255, 255)');
  path.setAttribute('stroke-width', '1');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  holder.append(svg);
  container.prepend(holder);
  let at: { readonly x: number; readonly y: number } | null = null;
  let disposed = false;
  const element = svg as unknown as HTMLElement;
  return Object.freeze({
    show(x: number, y: number) {
      if (disposed) {
        throw new Error('the virtual cursor was disposed');
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new RangeError(
          `a virtual cursor is shown at a finite point (got ${String(x)}, ${String(y)})`,
        );
      }
      at = Object.freeze({ x, y });
      set(element, { display: 'block', transform: `translate(${String(x)}px, ${String(y)}px)` });
    },
    hide() {
      at = null;
      set(element, { display: 'none' });
    },
    position: () => at,
    dispose() {
      disposed = true;
      at = null;
      holder.remove();
    },
  });
}

function set(element: HTMLElement, properties: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(properties)) {
    element.style.setProperty(name, value);
  }
}
