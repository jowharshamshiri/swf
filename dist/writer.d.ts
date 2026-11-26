/**
 * Writes element properties only when they change, and counts the writes it makes. It compares
 * with what it last wrote (not with what the browser reports back, which may be serialized
 * differently), so an unchanged view makes no writes at all.
 */
export declare class DomWriter {
    #private;
    /** Writes made since the last call. */
    take(): number;
    style(element: HTMLElement, properties: Readonly<Record<string, string>>): void;
    attribute(element: Element, name: string, value: string): void;
    toggle(element: Element, name: string, on: boolean): void;
    /** Counts a change to which elements the view holds (one added or taken out). */
    structure(): void;
    /** Sets an element's text content; it is always text, never markup. */
    text(element: Element, value: string): void;
}
//# sourceMappingURL=writer.d.ts.map