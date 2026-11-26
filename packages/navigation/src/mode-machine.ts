import type { ProjectionSetting } from '@swf/core';
import type { Quat } from '@swf/math';
import type * as Lean from '@swf/models';
import { fromJson, models, toJson } from '@swf/models';

/**
 * Which view mode a viewport is in, and the view it was entered from. The machine is the Lean
 * model `Swf.ViewMode` (models/Swf/ViewMode.lean), where its invariants are proved; this module
 * only carries its states across. Nothing here touches a scene: a transition says which mode comes
 * next and which view settings to put back, and the caller turns that into one view-state commit.
 * World transforms are never part of it.
 */

/** A viewport's view settings, as they were when a mode was entered. */
export interface ViewSettings {
  /** The viewport's mode. */
  readonly mode: string;
  /** The viewport's projection. */
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
  const observed = models.observed(leanMachine(machine), recorded);
  return observed === null ? machine : machineOf(observed);
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
  const next = models.transition(
    leanMachine(machine),
    event,
    leanView(current),
    traits(machine.mode).restoresView,
  );
  if (next.kind === 'refused') {
    return Object.freeze({ kind: 'refused', reason: next.reason });
  }
  return Object.freeze({
    kind: 'next',
    machine: machineOf(next.machine),
    mode: next.mode,
    projection: next.projection === null ? null : projectionOf(next.projection),
    camera: next.camera === null ? null : quatOf(next.camera),
  });
}

function leanMachine(machine: ModeMachine): Lean.ModeMachine {
  return { mode: machine.mode, origin: machine.from === null ? null : leanView(machine.from) };
}

function leanView(view: ViewSettings): Lean.ViewSettings {
  const [x, y, z, w] = view.camera;
  return {
    mode: view.mode,
    projection: {
      id: view.projection.id,
      config: toJson(view.projection.config, 'projection.config'),
    },
    camera: { x, y, z, w },
  };
}

function machineOf(machine: Lean.ModeMachine): ModeMachine {
  return Object.freeze({
    mode: machine.mode,
    from: machine.origin === null ? null : viewOf(machine.origin),
  });
}

function viewOf(view: Lean.ViewSettings): ViewSettings {
  return Object.freeze({
    mode: view.mode,
    projection: projectionOf(view.projection),
    camera: quatOf(view.camera),
  });
}

function projectionOf(projection: Lean.ProjectionSetting): ProjectionSetting {
  return Object.freeze({ id: projection.id, config: fromJson(projection.config) });
}

function quatOf(q: Lean.Quat): Quat {
  return Object.freeze([q.x, q.y, q.z, q.w] as const);
}
