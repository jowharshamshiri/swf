import { FOCUS_ID, MAP, OVERVIEW } from '@swf/navigation';
import type { NavigationModel } from './model.svelte.js';
import { offeredModes } from './modes.js';

/** Inputs that are pressed or chosen, not typed in. */
const NOT_TYPED = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'];

/**
 * Whether a key's target takes typing and keeps its own keys (its own undo among them): a field,
 * or whatever has the keyboard in a window's live content, in the slot the host's content is
 * attached to, whichever backend presents it. A checkbox, a choice or a button takes none.
 */
export function takesTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      (target instanceof HTMLInputElement && !NOT_TYPED.includes(target.type)) ||
      target.closest('textarea, select, [data-swf-slot]') !== null)
  );
}

/**
 * Navigation's keys, for a host's page-wide key handler to call with every key it does not take
 * first. Wherever the keyboard is but in a field or a window's own content (UX-012), as VS Code:
 * Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes (Cmd on a Mac); Escape cancels a gesture running, or
 * else closes the focus, as it leaves VS Code's zen mode. While the panorama itself has the
 * keyboard, and only then (so a single key never acts from anywhere else, WCAG 2.1.4): 1 to 9 show
 * the views in the switcher's order, F focuses the selected window, M shows the map, Delete or
 * Backspace removes the selected windows (one change, with an undo offered), and Escape leaves the
 * map or the overview for the view it was opened from. In the panorama the framework's own keys
 * act first. True when it took the key, which it then keeps from the page.
 */
export function navigationKey(model: NavigationModel, event: KeyboardEvent): boolean {
  const navigation = model.navigation;
  if (event.defaultPrevented || navigation === null || takesTyping(event.target)) {
    return false;
  }
  const command = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const take = (run: () => Promise<boolean>): true => {
    event.preventDefault();
    void run();
    return true;
  };
  if (command && !event.altKey) {
    const undo = key === 'z' && !event.shiftKey;
    const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey);
    if (undo || redo) {
      return take(() => model.runNavigation(undo ? 'swf.history.undo' : 'swf.history.redo', {}));
    }
    return false;
  }
  if (event.key === 'Escape' && model.policies?.gesture != null) {
    return take(() => model.runNavigation('swf.gesture.cancel', {}));
  }
  if (event.key === 'Escape' && model.status?.mode === FOCUS_ID) {
    return take(() => model.runNavigation('swf.focus.exit', {}));
  }
  if (event.target !== navigation.root || event.altKey) {
    return false;
  }
  const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : null;
  if (digit !== null) {
    const mode = offeredModes(model)[digit - 1];
    return mode === undefined || mode.disabled
      ? false
      : take(() => model.runNavigation('swf.mode.switch', { mode: mode.value }));
  }
  if (key === 'f' && model.policies?.features.enabled.focus === true) {
    return take(() => model.runNavigation('swf.focus.enter', {}));
  }
  if (key === 'm' && model.policies?.features.enabled.map === true) {
    return take(() => model.runNavigation('swf.mode.switch', { mode: MAP.id }));
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    // As a file explorer: Delete (or Backspace) removes what is selected, with an undo offered.
    const selection = model.selection;
    return selection.length === 0 ? false : take(() => model.removeWindows(selection));
  }
  if (
    event.key === 'Escape' &&
    (model.status?.mode === MAP.id || model.status?.mode === OVERVIEW.id)
  ) {
    return take(() => model.runNavigation('swf.mode.back', {}));
  }
  return false;
}
