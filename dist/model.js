/**
 * The flags an entity has unless its spec says otherwise: everything enabled, unlocked, priority
 * 0. The object is frozen.
 */
export const DEFAULT_FLAGS = Object.freeze({
    visible: true,
    selectable: true,
    draggable: true,
    resizable: true,
    rotatable: true,
    pointerEnabled: true,
    locked: false,
    presentationPriority: 0,
});
export const FLAG_NAMES = Object.freeze(Object.keys(DEFAULT_FLAGS));
//# sourceMappingURL=model.js.map