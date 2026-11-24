import { afterEach, describe, expect, it } from 'vitest';
import { createVirtualCursor, DOM_ATTRIBUTES, VIRTUAL_CURSOR_LAYER } from '../../src/index.js';

let container: HTMLElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

describe('a virtual cursor (FR-107)', () => {
  it('draws its tip at a point of the container, takes no input and shifts nothing', () => {
    container = document.createElement('div');
    container.style.setProperty('margin', '20px 0 0 30px');
    container.style.setProperty('width', '400px');
    container.style.setProperty('height', '200px');
    const content = document.createElement('div');
    content.style.setProperty('height', '200px');
    container.append(content);
    document.body.append(container);
    const before = content.getBoundingClientRect().top;
    const cursor = createVirtualCursor({ container });
    const holder = container.querySelector<HTMLElement>(
      `[${DOM_ATTRIBUTES.layer}="${VIRTUAL_CURSOR_LAYER}"]`,
    );
    const arrow = holder?.firstElementChild;
    expect(holder?.getAttribute('aria-hidden')).toBe('true');
    expect(content.getBoundingClientRect().top).toBe(before);
    expect(cursor.position()).toBeNull();
    expect(arrow?.getBoundingClientRect().width).toBe(0);

    cursor.show(120, 50);
    const box = container.getBoundingClientRect();
    const tip = arrow?.getBoundingClientRect();
    expect(tip?.left).toBeCloseTo(box.left + 120, 0);
    expect(tip?.top).toBeCloseTo(box.top + 50, 0);
    expect(cursor.position()).toEqual({ x: 120, y: 50 });
    // A press where it is drawn goes to what is under it.
    expect(document.elementFromPoint(box.left + 122, box.top + 55)).toBe(content);

    cursor.hide();
    expect(cursor.position()).toBeNull();
    expect(() => {
      cursor.show(Number.NaN, 0);
    }).toThrow(/finite point/);
    cursor.dispose();
    expect(
      container.querySelector(`[${DOM_ATTRIBUTES.layer}="${VIRTUAL_CURSOR_LAYER}"]`),
    ).toBeNull();
    expect(() => {
      cursor.show(0, 0);
    }).toThrow(/disposed/);
  });
});
