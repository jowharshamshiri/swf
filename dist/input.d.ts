import type { Id } from '@swf/core';
import type { InputAdapter, InteractionEvent } from '@swf/interaction';
/** Which view's DOM to take input from, and for which viewport. */
export interface DomInputOptions {
    /** A versioned adapter ID. Default `swf.dom-input/1`; give each viewport's adapter its own. */
    readonly id?: string;
    /**
     * The view's root element: input over it is offered to the framework. Pointer positions are
     * measured from its top left, in CSS pixels. It stays the host's.
     */
    readonly root: HTMLElement;
    /** The viewport every intent names. */
    readonly viewportId: Id;
    /**
     * Router notifications, so captured pointers are released when their gesture ends: a function
     * that subscribes a listener and returns what unsubscribes it, such as the router's
     * `subscribe`.
     */
    readonly events: (listener: (event: InteractionEvent) => void) => () => void;
}
/**
 * Connects a view's DOM to the interaction router. It listens on the view's root in the capture
 * phase and offers every pointer, wheel and key event as an intent. When the framework consumes
 * one, the event stops there (so content does not act on it too) and a pressed pointer is
 * captured on the root until its gesture ends. When it does not, the event is left untouched and
 * the browser delivers it to the content as the genuine event it is: nothing is synthesized or
 * re-dispatched, and content in a cross-origin frame receives its input from the browser alone.
 *
 * Wheel deltas are given in CSS pixels: a line is 16 px and a page the root's height. Keys
 * pressed inside a live slot are offered with focus `content`, others with focus `workspace`.
 * Pen and touch pointers carry pressure (clamped to 0 to 1), tilt and twist.
 *
 * The adapter connects to one router at a time: `connect` adds its listeners to the root and
 * subscribes to `events`, and the function it returns removes and unsubscribes them again. A
 * second `connect` before that throws {@link SwfFailure} (`INVALID_TRANSITION`).
 */
export declare function createDomInput(options: DomInputOptions): InputAdapter;
//# sourceMappingURL=input.d.ts.map