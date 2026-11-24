import type { ProjectionSetting } from '@swf/core';
import type { Quat } from '@swf/math';

/**
 * Which view mode a viewport is in, and the view it was entered from, as plain data with explicit
 * transitions. Nothing here touches a scene: a transition says which mode comes next and which view
 * settings to put back, and the caller turns that into one view-state commit. World transforms are
 * never part of it.
 */

/** A viewport's view settings, as they were when a mode was entered. */
export interface ViewSettings {
  readonly mode: string;
  readonly projection: ProjectionSetting;
  /** The rotation of the viewport's camera. */
  readonly camera: Quat;
}

export interface ModeMachine {
  /** The mode the viewport is in. */
  readonly mode: string;
  /**
   * The view the mode was entered from: where going back returns to. Null when there is none to
   * return to (the first mode, or one reached by going back).
   */
  readonly from: ViewSettings | null;
}

/** What a mode is to the machine. */
export interface ModeTraits {
  /**
   * Leaving the mode by any route puts the camera back as it was when the mode was entered: what
   * the mode changed of the view (a turn to face what it presents) was the mode's own.
   */
  readonly restoresView: boolean;
}

export type ModeEvent =
  /** Switch to a mode; switching to the mode the viewport is in enters it again (focus anew). */
  | { readonly kind: 'switch'; readonly to: string }
  /** Leave the mode for the view it was entered from. */
  | { readonly kind: 'back' };

/** The result of a transition. */
export type ModeTransition =
  | {
      readonly kind: 'next';
      readonly machine: ModeMachine;
      /** The mode the viewport switches to. */
      readonly mode: string;
      /**
       * The projection to show it with when it is the one the view was in before (going back);
       * null for the mode's own.
       */
      readonly projection: ProjectionSetting | null;
      /** The camera rotation to put back, or null to leave the camera as it is. */
      readonly camera: Quat | null;
    }
  | { readonly kind: 'refused'; readonly reason: string };

/** The machine of a viewport first shown in `mode`. */
export function initialMode(mode: string): ModeMachine {
  return Object.freeze({ mode, from: null });
}

/**
 * The machine after the viewport's record changed its mode by some other route than a transition:
 * it is in that mode, with no view to go back to.
 */
export function observedMode(machine: ModeMachine, recorded: string): ModeMachine {
  return machine.mode === recorded ? machine : initialMode(recorded);
}

/**
 * The next state for an event, from the view the viewport shows now and what each mode is.
 * Switching remembers the view it leaves (or, leaving a mode that restores the view, the view
 * that mode was entered from, since that is the view put back); going back returns to the
 * remembered view and forgets it.
 */
export function transition(
  machine: ModeMachine,
  event: ModeEvent,
  current: ViewSettings,
  traits: (mode: string) => ModeTraits,
): ModeTransition {
  if (current.mode !== machine.mode) {
    return refused(
      `the viewport shows the ${current.mode} mode, but the machine is in the ${machine.mode} mode`,
    );
  }
  const leaving = traits(machine.mode);
  const restored = leaving.restoresView && machine.from !== null ? machine.from.camera : null;
  if (event.kind === 'back') {
    const from = machine.from;
    if (from === null) {
      return refused(`the ${machine.mode} mode was not entered from another view`);
    }
    return Object.freeze({
      kind: 'next',
      machine: initialMode(from.mode),
      mode: from.mode,
      projection: from.projection,
      camera: leaving.restoresView ? from.camera : null,
    });
  }
  if (event.to === machine.mode) {
    // Entered again: the view it was first entered from stays the one to go back to.
    return Object.freeze({
      kind: 'next',
      machine,
      mode: event.to,
      projection: null,
      camera: null,
    });
  }
  // Leaving a mode that restores the view, the view left is the one put back.
  const left: ViewSettings = leaving.restoresView && machine.from !== null ? machine.from : current;
  return Object.freeze({
    kind: 'next',
    machine: Object.freeze({ mode: event.to, from: left }),
    mode: event.to,
    projection: null,
    camera: restored,
  });
}

function refused(reason: string): ModeTransition {
  return Object.freeze({ kind: 'refused', reason });
}
