import { FOCUS_ID } from '@swf/navigation';
import type { NavigationModel } from './model.svelte.js';

/** A view mode as a switcher offers it. */
export interface OfferedMode {
  /** The mode's ID. */
  readonly value: string;
  /** Its name, in the model's messages. */
  readonly label: string;
  /** Not offered now: focus needs a window, offered once one is selected or focused. */
  readonly disabled: boolean;
}

/**
 * The view modes a switcher offers, in the order they registered: each named, and focus offered
 * only once a window is selected or focused, or while it is shown. Read inside a derivation, it
 * follows the model.
 */
export function offeredModes(model: NavigationModel): OfferedMode[] {
  const focusable =
    model.selected !== null || model.status?.mode === FOCUS_ID || model.focusedId !== null;
  return model.modes.map((mode) => ({
    value: mode.id,
    label: model.messages.named(mode.name),
    disabled: mode.id === FOCUS_ID && !focusable,
  }));
}

/** Below this width in CSS pixels the panorama is compact (a phone, NFR-023). */
export const COMPACT_BELOW = 600;

/**
 * Whether the panorama is too narrow for every control across its top: then a switcher offers its
 * modes as a list, and what a background drag turns is left to the command list.
 */
export function compactView(model: NavigationModel): boolean {
  return model.viewWidth !== null && model.viewWidth < COMPACT_BELOW;
}
