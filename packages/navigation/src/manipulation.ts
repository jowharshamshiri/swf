import type { CancelReason, SceneCommand, SwfError } from '@swf/core';
import type {
  ClaimContext,
  GestureClaim,
  GestureFinish,
  InteractionPolicy,
  PointerIntent,
} from '@swf/interaction';
import { INTERACTION_API_VERSION } from '@swf/interaction';

/**
 * Direct manipulation in the panorama beyond the framework's own move and resize: Ctrl (⌘ on a
 * Mac) and click on a window, which joins the selection, or leaves it if it was in it, as Ctrl and
 * click do in a list; a plain click selects it alone. It is taken on a window's frame or its edges
 * (where a plain drag would move or resize it), or on its content wherever a plain drag would move
 * it (a proxy, or with Alt held). Moving a window nearer or farther is the framework's own move,
 * with Shift held.
 */

export const SELECT_TOGGLE_POLICY_ID = 'swf.navigation.select-toggle/1';

const reasonOf = (error: SwfError): CancelReason =>
  error.code === 'CONSTRAINT_REJECTED' || error.code === 'LOCKED'
    ? 'constraint-rejected'
    : 'commit-rejected';

/**
 * Where a press may take a window with a modifier: its title bar, its card, its edges, or grabbable
 * content.
 */
function onWindow(context: ClaimContext): boolean {
  return (
    context.region === 'title-bar' ||
    context.region === 'chrome' ||
    context.region === 'resize-handle' ||
    (context.region === 'content' &&
      (context.takeover || (context.pick.kind === 'hit' && context.pick.target.proxy)))
  );
}

/** Ctrl, or ⌘ on a Mac, held at the press. */
const commandHeld = (pointer: PointerIntent): boolean =>
  pointer.modifiers.ctrl || pointer.modifiers.meta;

/**
 * Ctrl (⌘) and click on a window: it joins the selection first, or leaves it if it was in it
 * (`selection.set`), committed at once. Locked windows can be selected too.
 */
export const selectTogglePolicy: InteractionPolicy = Object.freeze({
  id: SELECT_TOGGLE_POLICY_ID,
  apiVersion: INTERACTION_API_VERSION,
  priority: 1,
  operations: Object.freeze(['selection.set']),
  claim(context: ClaimContext): GestureClaim | null {
    const down = context.pointers[0];
    if (
      context.pointers.length !== 1 ||
      down === undefined ||
      !commandHeld(down) ||
      context.pick.kind !== 'hit' ||
      !onWindow(context)
    ) {
      return null;
    }
    const id = context.pick.target.nodeId;
    const selection = context.scene.selection;
    const ids = selection.includes(id)
      ? selection.filter((other) => other !== id)
      : [id, ...selection];
    const commands: SceneCommand[] = [{ type: 'selection.set', ids }];
    return {
      kind: 'tap',
      pointers: 1,
      operation: 'selection.set',
      nodeId: id,
      begin: (session) => ({
        update: () => undefined,
        finish(): GestureFinish {
          const result = session.transact(commands);
          return result.status === 'committed'
            ? { outcome: 'committed', transactionId: result.transactionId }
            : { outcome: 'cancelled', reason: reasonOf(result.error), error: result.error };
        },
        cancel: () => undefined,
      }),
    };
  },
});

/** The manipulation policies, as navigation registers them. */
export const MANIPULATION_POLICIES: readonly InteractionPolicy[] = Object.freeze([
  selectTogglePolicy,
]);
