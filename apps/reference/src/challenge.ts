import type * as Lean from '@swf/models';
import { models } from '@swf/models';
import type { MessageId } from './messages.js';

/**
 * The timed window-finding task: an optional measure of how quickly the operator reaches a window
 * by one way of navigating against another. The operator picks a way to navigate and starts a run;
 * the task names a window to find (behind the camera whenever one is) and counts the operator's
 * presses and keys until that window is selected, by whatever route, then records the run. The
 * records stay for the visit, each with its way of navigating, and are summed up by way so the
 * ways compare. Which window a run names, what counts and when a run ends is the Lean model
 * `Swf.AppChallenge` (models/Swf/AppChallenge.lean); the application measures the time and the
 * camera.
 */

/**
 * The ways of navigating the task compares: turning the camera in the panorama, turning the
 * workspace round the camera, the map, the overview's tiles, and finding by name (the Windows
 * view's search or the command list).
 */
export const METHOD_IDS = ['camera', 'orbit', 'map', 'overview', 'search'] as const;
export type MethodId = (typeof METHOD_IDS)[number];

export const METHOD_NAMES: Readonly<Record<MethodId, MessageId>> = Object.freeze({
  camera: 'challenge.method.camera',
  orbit: 'challenge.method.orbit',
  map: 'challenge.method.map',
  overview: 'challenge.method.overview',
  search: 'challenge.method.search',
});

/** A refusal to start a run, by the field at fault: said to the operator as it is. */
export class ChallengeRefusal extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChallengeRefusal';
  }
}

/** A window the task could name, as the application sees it now. */
export interface ChallengeCandidate {
  readonly id: string;
  readonly label: string;
  /** More than a quarter turn from where the camera faces. */
  readonly behind: boolean;
}

/** A run under way. */
export interface ChallengeRun {
  readonly target: string;
  readonly label: string;
  readonly method: MethodId;
  /** When it started, by the task's clock, in milliseconds. */
  readonly startedAt: number;
  readonly actions: number;
}

/** A run finished. */
export interface ChallengeRecord {
  readonly target: string;
  readonly label: string;
  readonly method: MethodId;
  readonly ms: number;
  readonly actions: number;
}

/** The runs of one way of navigating, summed up. */
export interface MethodSummary {
  readonly method: MethodId;
  readonly runs: number;
  readonly bestMs: number;
  readonly meanMs: number;
  readonly meanActions: number;
}

export interface ChallengeStatus {
  readonly run: ChallengeRun | null;
  readonly records: readonly ChallengeRecord[];
  /** Why the last run ended without being finished, until the next starts. */
  readonly ended: 'removed' | null;
}

export interface Challenge {
  status(): ChallengeStatus;
  subscribe(listener: () => void): () => void;
  /**
   * Starts a run in place of any under way, naming a window from the candidates (never the
   * selected one): the window named, or null when there is none to name.
   */
  start(
    method: MethodId,
    candidates: readonly ChallengeCandidate[],
    selected: string | null,
  ): ChallengeRun | null;
  /** The operator pressed or keyed something. */
  act(): void;
  /** A window was selected. */
  selected(id: string): void;
  /** The window the run names is gone: the run ends unfinished. */
  removed(): void;
  /** Gives the run under way up. Throws when there is none. */
  cancel(): void;
  /** Forgets the records. */
  clear(): void;
  dispose(): void;
}

export interface ChallengeOptions {
  /** A monotonic clock, in milliseconds. */
  readonly now: () => number;
  /** A draw in [0, 1): which of the windows the task may name it names. */
  readonly random: () => number;
}

/** The runs of each way of navigating, summed up, in the ways' order; ways not run are left out. */
export function summarize(records: readonly ChallengeRecord[]): MethodSummary[] {
  return METHOD_IDS.flatMap((method) => {
    const runs = records.filter((r) => r.method === method);
    if (runs.length === 0) {
      return [];
    }
    const sum = (f: (r: ChallengeRecord) => number) => runs.reduce((s, r) => s + f(r), 0);
    return [
      Object.freeze({
        method,
        runs: runs.length,
        bestMs: Math.min(...runs.map((r) => r.ms)),
        meanMs: sum((r) => r.ms) / runs.length,
        meanActions: sum((r) => r.actions) / runs.length,
      }),
    ];
  });
}

/** The draws the task makes are whole numbers below this. */
const DRAWS = 2 ** 32;

const sameRun = (a: Lean.ChallengeRun | null, b: Lean.ChallengeRun | null): boolean =>
  a === null || b === null
    ? a === b
    : a.target === b.target &&
      a.method === b.method &&
      a.startedAt === b.startedAt &&
      a.actions === b.actions;

export function createChallenge(options: ChallengeOptions): Challenge {
  let task: Lean.ChallengeTask = { run: null, records: [] };
  /** Each window's label when its run started, by ID. */
  const labels = new Map<string, string>();
  let ended: ChallengeStatus['ended'] = null;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  /** The clock now, as the whole milliseconds the model counts in. */
  const now = () => {
    const at = Math.round(options.now());
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new RangeError(`the task's clock gives milliseconds from zero (got ${String(at)})`);
    }
    return BigInt(at);
  };
  const methodOf = (id: string): MethodId => {
    if (!(METHOD_IDS as readonly string[]).includes(id)) {
      throw new Error(`no way of navigating "${id}"`);
    }
    return id as MethodId;
  };
  const labelOf = (id: string): string => {
    const label = labels.get(id);
    if (label === undefined) {
      throw new Error(`the task named "${id}" without its label`);
    }
    return label;
  };
  const apply = (event: Lean.ChallengeEvent): Lean.ChallengeRecord | null => {
    const answer = models.challengeStep(task, event);
    switch (answer.kind) {
      case 'next': {
        const changed =
          !sameRun(answer.task.run, task.run) || answer.task.records.length !== task.records.length;
        task = answer.task;
        if (changed) {
          tell();
        }
        return answer.found;
      }
      case 'notRunning':
        throw new Error('no run is under way');
      case 'timeBackwards':
        throw new Error("the task's clock ran backwards");
    }
  };
  const status = (): ChallengeStatus => {
    const run = task.run;
    return Object.freeze({
      run:
        run === null
          ? null
          : Object.freeze({
              target: run.target,
              label: labelOf(run.target),
              method: methodOf(run.method),
              startedAt: Number(run.startedAt),
              actions: Number(run.actions),
            }),
      records: Object.freeze(
        task.records.map((r) =>
          Object.freeze({
            target: r.target,
            label: labelOf(r.target),
            method: methodOf(r.method),
            ms: Number(r.ms),
            actions: Number(r.actions),
          }),
        ),
      ),
      ended,
    });
  };
  const challenge: Challenge = {
    status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(method, candidates, selected) {
      methodOf(method);
      const drawn = options.random();
      const draw = Math.floor(drawn * DRAWS);
      if (!Number.isSafeInteger(draw) || draw < 0 || draw >= DRAWS) {
        throw new RangeError(`a draw is in [0, 1) (got ${String(drawn)})`);
      }
      const target = models.challengeTarget(
        candidates.map((c) => ({ id: c.id, behind: c.behind })),
        selected,
        BigInt(draw),
      );
      if (target === null) {
        return null;
      }
      const candidate = candidates.find((c) => c.id === target);
      if (candidate === undefined) {
        throw new Error(`the task named "${target}", which is no candidate`);
      }
      labels.set(target, candidate.label);
      ended = null;
      apply({ kind: 'start', target, method, time: now() });
      return status().run;
    },
    act() {
      apply({ kind: 'act' });
    },
    selected(id) {
      apply({ kind: 'selected', id, time: now() });
    },
    removed() {
      ended = 'removed';
      apply({ kind: 'cancel' });
    },
    cancel() {
      ended = null;
      apply({ kind: 'cancel' });
    },
    clear() {
      apply({ kind: 'clear' });
    },
    dispose() {
      listeners.clear();
    },
  };
  return Object.freeze(challenge);
}
