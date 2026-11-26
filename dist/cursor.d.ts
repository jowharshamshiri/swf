/** The layer name a virtual cursor's element carries. */
export declare const VIRTUAL_CURSOR_LAYER = "virtual-cursor";
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
/**
 * Creates a virtual cursor in a view's container. It sits in a holder of no size at the
 * container's top left, so its coordinates are the container's whatever the container's own
 * positioning, and it never shifts what the container lays out. It starts hidden. The holder is
 * prepended to the container, which stays the caller's; the caller disposes the cursor to take
 * the holder out again.
 */
export declare function createVirtualCursor(options: {
    readonly container: HTMLElement;
}): VirtualCursor;
//# sourceMappingURL=cursor.d.ts.map