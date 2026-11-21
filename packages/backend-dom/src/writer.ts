/**
 * Writes element properties only when they change, and counts the writes it makes. It compares
 * with what it last wrote (not with what the browser reports back, which may be serialized
 * differently), so an unchanged view makes no writes at all.
 */
export class DomWriter {
  readonly #written = new WeakMap<Element, Map<string, string | boolean>>();
  #count = 0;

  /** Writes made since the last call. */
  take(): number {
    const count = this.#count;
    this.#count = 0;
    return count;
  }

  style(element: HTMLElement, properties: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(properties)) {
      if (this.#changed(element, `style:${name}`, value)) {
        element.style.setProperty(name, value);
      }
    }
  }

  attribute(element: Element, name: string, value: string): void {
    if (this.#changed(element, `attr:${name}`, value)) {
      element.setAttribute(name, value);
    }
  }

  toggle(element: Element, name: string, on: boolean): void {
    if (this.#changed(element, `toggle:${name}`, on)) {
      element.toggleAttribute(name, on);
    }
  }

  /** Counts a change to which elements the view holds (one added or taken out). */
  structure(): void {
    this.#count += 1;
  }

  /** Sets an element's text content; it is always text, never markup. */
  text(element: Element, value: string): void {
    if (this.#changed(element, 'text', value)) {
      element.textContent = value;
    }
  }

  #changed(element: Element, key: string, value: string | boolean): boolean {
    let written = this.#written.get(element);
    if (written === undefined) {
      written = new Map();
      this.#written.set(element, written);
    }
    if (written.get(key) === value) {
      return false;
    }
    written.set(key, value);
    this.#count += 1;
    return true;
  }
}
