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

/** The keys a host may give navigation's keys other than their defaults. */
export interface NavigationKeys {
  /**
   * The key that takes the keyboard out of a window's live content to the view
   * (`swf.content.leave`), as `KeyboardEvent.key` names it with no modifier held. Default `F6`, the
   * key browsers and editors move the keyboard between a page's parts by, which terminals and
   * editors seldom bind: a host whose content needs F6 gives another.
   */
  readonly leaveContent: string;
}

/** Navigation's keys as they are by default. */
export const DEFAULT_NAVIGATION_KEYS: NavigationKeys = Object.freeze({ leaveContent: 'F6' });

/**
 * Navigation's keys, for a host's page-wide key handler to call with every key it does not take
 * first, those typed in a field or a window's content included. In a window's live content, only
 * the key that leaves it (`keys.leaveContent`, F6 by default) is navigation's: it takes the
 * keyboard out to the view, so Escape and the view's keys reach it again. Wherever the keyboard is but in a field or a window's own content (UX-012), as VS Code:
 * Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes (Cmd on a Mac); Escape cancels a gesture running, or
 * else closes the focus, as it leaves VS Code's zen mode. While the panorama itself has the
 * keyboard, and only then (so a single key never acts from anywhere else, WCAG 2.1.4): 1 to 9 show
 * the views in the switcher's order, F focuses the selected window, M shows the map, Delete or
 * Backspace removes the selected windows (one change, with an undo offered), and Escape leaves the
 * map or the overview for the view it was opened from. In the panorama the framework's own keys
 * act first. True when it took the key, which it then keeps from the page.
 */
export function navigationKey(
  model: NavigationModel,
  event: KeyboardEvent,
  keys: NavigationKeys = DEFAULT_NAVIGATION_KEYS,
): boolean {
  const navigation = model.navigation;
  if (event.defaultPrevented || navigation === null) {
    return false;
  }
  const inContent =
    event.target instanceof Element &&
    event.target.closest('[data-swf-slot]') !== null &&
    navigation.root.contains(event.target);
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (inContent && plain && event.key === keys.leaveContent) {
    event.preventDefault();
    void model.runNavigation('swf.content.leave', {});
    return true;
  }
  if (takesTyping(event.target)) {
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
