import type { SceneState } from '@swf/core';
import type * as Lean from '@swf/models';
import { models } from '@swf/models';
import type { AppCommandId, AppCommandSpecs } from './commands.js';
import type { DepthBands, FeatureId, Pose } from '@swf/navigation';
import { FOCUS_ID, wrapDegrees } from '@swf/navigation';
import type { MessageId } from './messages.js';
import type { SpaceEntry } from '@swf/persistence';
import { DEFAULT_SPACE } from './config.js';

/**
 * The reference application's guided scenarios: each shows one of the framework's principal
 * behaviours in the studio scene, a few steps at a time. A scenario starts from the studio as it is
 * planned (one undoable change, so undo brings back the workspace it replaced), with the features it
 * shows turned on; it says the step due, and ticks it off once the operator has done it, by any
 * route the application offers (the panorama, the keyboard, the inspector, the map, the command
 * list). Each step can also be shown: the application does it as its own controls would. How a
 * scenario advances is the Lean model `Swf.AppScenarios` (models/Swf/AppScenarios.lean); what each
 * step's condition reads is the scene, here.
 */

export const SCENARIO_IDS = ['behind', 'hidden', 'depth', 'focus', 'compose', 'restore'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** What a step's condition reads: the application as it is now. */
export interface ScenarioWorld {
  /** The committed scene. */
  readonly scene: SceneState;
  readonly mode: string;
  /** Where the camera faces, in degrees to the right of straight ahead. */
  readonly cameraHeading: number;
  /** How a window stands in the committed scene, or null when there is no such window. */
  pose(id: string): Pose | null;
  readonly depth: DepthBands;
  /** The spaces, as the store holds them. */
  readonly spaces: readonly SpaceEntry[];
  /** The space shown. */
  readonly space: string | null;
  /** How many spaces have been switched to since the application started. */
  readonly switches: number;
}

/** What showing a step does: one of the application's commands, or a shell action. */
export type Demonstration =
  | { readonly kind: 'command'; readonly command: Command }
  /** Shows a window on the map, centred there. */
  | { readonly kind: 'map'; readonly id: string };

/** One of the application's commands with its parameters. */
export type Command = {
  [K in AppCommandId]: { readonly id: K; readonly params: AppCommandSpecs[K] };
}[AppCommandId];

const command = <K extends AppCommandId>(id: K, params: AppCommandSpecs[K]): Demonstration => ({
  kind: 'command',
  command: { id, params } as Command,
});

export interface ScenarioStep {
  /** The step's stable ID within its scenario. */
  readonly id: string;
  /** What to do. */
  readonly text: MessageId;
  /** The ways the application offers to do it. */
  readonly hint: MessageId;
  /**
   * Whether it is done: read against the world now and as it was when each step so far became due
   * (`due[i]` for step `i`, this step's own last).
   */
  holds(world: ScenarioWorld, due: readonly ScenarioWorld[]): boolean;
  /** How the application does it, from the world now. */
  show(world: ScenarioWorld): Demonstration;
}

export interface Scenario {
  readonly id: ScenarioId;
  readonly name: MessageId;
  readonly summary: MessageId;
  /** The features it shows, turned on when it starts. */
  readonly features: readonly FeatureId[];
  readonly steps: readonly ScenarioStep[];
}

/** How far a window is round from where the camera faces, in degrees from 0 to 180. */
export function offCamera(world: { readonly cameraHeading: number }, pose: Pose): number {
  return Math.abs(wrapDegrees(pose.heading - world.cameraHeading));
}

/** Behind the camera: more than this many degrees round from where it faces, a quarter turn. */
export const BEHIND = 90;
/** In front, to look at: within this many degrees of where the camera faces. */
const FACING = 30;

const selected = (world: ScenarioWorld, id: string) => world.scene.selection[0] === id;
const ownerOf = (world: ScenarioWorld, surfaceId: string) =>
  world.scene.surfaces.get(surfaceId)?.ownerNodeId ?? null;
/** A refusal to show a step, by the field at fault: said to the operator as it is. */
export class ScenarioRefusal extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ScenarioRefusal';
  }
}

/**
 * How a scenario's window stands, to show a step with: a window the operator removed cannot be
 * shown, and is refused, naming it.
 */
const poseIn = (world: ScenarioWorld, id: string): Pose => {
  const pose = world.pose(id);
  if (pose === null) {
    throw new ScenarioRefusal(
      'window',
      `the scenario's window "${id}" is no longer in the workspace: undo its removal, or start the scenario again`,
    );
  }
  return pose;
};
/** Whether a scenario's window stands as a step asks; never, while it is not in the workspace. */
const stands = (world: ScenarioWorld, id: string, test: (pose: Pose) => boolean): boolean => {
  const pose = world.pose(id);
  return pose !== null && test(pose);
};
/** Where a window stands moved along its line from the camera to a distance. */
const atDistance = (pose: Pose, distance: number) => {
  const [x, y, z] = pose.position;
  const k = distance / pose.distance;
  return { x: x * k, y: y * k, z: z * k };
};
/** The last world a step became due in. */
const last = (due: readonly ScenarioWorld[]): ScenarioWorld => {
  const world = due.at(-1);
  if (world === undefined) {
    throw new Error('a step is read with the world it became due in');
  }
  return world;
};
/** Whether two scenes hold every window at the same place. */
function sameLayout(a: SceneState, b: SceneState): boolean {
  const windows = (scene: SceneState) =>
    [...scene.nodes.values()].filter((n) => n.kind === 'window' && n.status === 'active');
  const left = windows(a);
  if (left.length !== windows(b).length) {
    return false;
  }
  const near = (p: readonly number[], q: readonly number[]) =>
    p.every((v, i) => Math.abs(v - (q[i] ?? Number.NaN)) < 1e-6);
  return left.every((node) => {
    const other = b.nodes.get(node.id);
    return (
      other?.status === 'active' &&
      near(node.transform.position, other.transform.position) &&
      near(node.transform.rotation, other.transform.rotation)
    );
  });
}

/** The window each scenario works with, by its ID in the studio. */
const DESK = 'desk';
const TASKS = 'tasks';
const MEDIA = 'media';
const BOARD = 'board';
const BUILDS = 'builds';
const SOURCES_SURFACE = 'sources-surface';
/** The space the restore scenario saves the layout as. */
export const SCENARIO_LAYOUT = 'Studio layout';
/** The space the restore scenario switches to and back from: the studio's. */
const AWAY_SPACE = DEFAULT_SPACE;

const behind: Scenario = {
  id: 'behind',
  name: 'scenario.behind',
  summary: 'scenario.behind.summary',
  features: ['map'],
  steps: [
    {
      id: 'select',
      text: 'scenario.behind.select',
      hint: 'scenario.behind.select.hint',
      holds: (world) => selected(world, DESK),
      show: () => command('swf.window.inspect', { id: DESK }),
    },
    {
      id: 'move',
      text: 'scenario.behind.move',
      hint: 'scenario.behind.move.hint',
      holds: (world) => stands(world, DESK, (pose) => offCamera(world, pose) > BEHIND),
      show: (world) => {
        // Straight across the camera: as far round as it was in front, now behind.
        const [x, , z] = poseIn(world, DESK).position;
        return command('swf.window.place', { id: DESK, x: -x, z: -z });
      },
    },
    {
      id: 'map',
      text: 'scenario.behind.map',
      hint: 'scenario.behind.map.hint',
      holds: (world) => world.mode === 'map' && selected(world, DESK),
      show: () => ({ kind: 'map', id: DESK }),
    },
  ],
};

const hidden: Scenario = {
  id: 'hidden',
  name: 'scenario.hidden',
  summary: 'scenario.hidden.summary',
  features: ['focus'],
  steps: [
    {
      id: 'find',
      text: 'scenario.hidden.find',
      hint: 'scenario.hidden.find.hint',
      holds: (world) => selected(world, TASKS),
      show: () => command('swf.window.inspect', { id: TASKS }),
    },
    {
      id: 'face',
      text: 'scenario.hidden.face',
      hint: 'scenario.hidden.face.hint',
      holds: (world) => stands(world, TASKS, (pose) => offCamera(world, pose) < FACING),
      show: () => command('swf.window.reveal', { id: TASKS }),
    },
    {
      id: 'read',
      text: 'scenario.hidden.read',
      hint: 'scenario.hidden.read.hint',
      holds: (world) => world.mode === FOCUS_ID && world.scene.focusedId === TASKS,
      show: () => command('swf.focus.enter', { id: TASKS }),
    },
  ],
};

const depth: Scenario = {
  id: 'depth',
  name: 'scenario.depth',
  summary: 'scenario.depth.summary',
  features: ['depth'],
  steps: [
    {
      id: 'select',
      text: 'scenario.depth.select',
      hint: 'scenario.depth.select.hint',
      holds: (world) => selected(world, MEDIA),
      show: () => command('swf.window.inspect', { id: MEDIA }),
    },
    {
      id: 'near',
      text: 'scenario.depth.near',
      hint: 'scenario.depth.near.hint',
      holds: (world) => stands(world, MEDIA, (pose) => pose.distance < world.depth.full),
      show: (world) =>
        command('swf.window.place', {
          id: MEDIA,
          ...atDistance(poseIn(world, MEDIA), Math.max(world.depth.full - 1, 2)),
        }),
    },
    {
      id: 'far',
      text: 'scenario.depth.far',
      hint: 'scenario.depth.far.hint',
      holds: (world) => stands(world, MEDIA, (pose) => pose.distance >= world.depth.compact),
      show: (world) =>
        command('swf.window.place', {
          id: MEDIA,
          ...atDistance(poseIn(world, MEDIA), world.depth.compact + 1.5),
        }),
    },
  ],
};

const focus: Scenario = {
  id: 'focus',
  name: 'scenario.focus',
  summary: 'scenario.focus.summary',
  features: ['focus'],
  steps: [
    {
      id: 'enter',
      text: 'scenario.focus.enter',
      hint: 'scenario.focus.enter.hint',
      holds: (world) => world.mode === FOCUS_ID,
      show: () => command('swf.focus.enter', { id: DESK }),
    },
    {
      id: 'switch',
      text: 'scenario.focus.switch',
      hint: 'scenario.focus.switch.hint',
      holds: (world, due) =>
        world.mode === FOCUS_ID &&
        world.scene.focusedId !== null &&
        world.scene.focusedId !== last(due).scene.focusedId,
      show: () => command('swf.focus.step', { direction: 'right' }),
    },
    {
      id: 'leave',
      text: 'scenario.focus.leave',
      hint: 'scenario.focus.leave.hint',
      holds: (world) => world.mode !== FOCUS_ID,
      show: () => command('swf.focus.exit', {}),
    },
  ],
};

const compose: Scenario = {
  id: 'compose',
  name: 'scenario.compose',
  summary: 'scenario.compose.summary',
  features: ['composition'],
  steps: [
    {
      id: 'detach',
      text: 'scenario.compose.detach',
      hint: 'scenario.compose.detach.hint',
      holds: (world) => {
        const owner = ownerOf(world, SOURCES_SURFACE);
        return owner !== null && owner !== BOARD;
      },
      show: () => command('swf.surface.detach', { surfaceId: SOURCES_SURFACE }),
    },
    {
      id: 'move',
      text: 'scenario.compose.move',
      hint: 'scenario.compose.move.hint',
      holds: (world) => ownerOf(world, SOURCES_SURFACE) === DESK,
      show: () => command('swf.surface.move', { surfaceId: SOURCES_SURFACE, windowId: DESK }),
    },
    {
      id: 'back',
      text: 'scenario.compose.back',
      hint: 'scenario.compose.back.hint',
      holds: (world) => ownerOf(world, SOURCES_SURFACE) === BOARD,
      show: () => command('swf.surface.move', { surfaceId: SOURCES_SURFACE, windowId: BOARD }),
    },
  ],
};

const restore: Scenario = {
  id: 'restore',
  name: 'scenario.restore',
  summary: 'scenario.restore.summary',
  features: ['persistence'],
  steps: [
    {
      id: 'save',
      text: 'scenario.restore.save',
      hint: 'scenario.restore.save.hint',
      // The space is shown, stored since the step became due.
      holds: (world, due) => {
        const savedAt = (spaces: readonly SpaceEntry[]) =>
          spaces.find((s) => s.name === SCENARIO_LAYOUT)?.stored?.savedAt ?? null;
        const now = savedAt(world.spaces);
        const before = savedAt(last(due).spaces);
        return world.space === SCENARIO_LAYOUT && now !== null && (before === null || now > before);
      },
      show: () => command('reference.space.saveAs', { name: SCENARIO_LAYOUT }),
    },
    {
      id: 'change',
      text: 'scenario.restore.change',
      hint: 'scenario.restore.change.hint',
      // Anything moved, turned, added or removed in the space since it was saved.
      holds: (world, due) =>
        world.space === SCENARIO_LAYOUT && !sameLayout(world.scene, last(due).scene),
      show: (world) => {
        const [x, , z] = poseIn(world, BUILDS).position;
        return command('swf.window.place', { id: BUILDS, x: -x, z: -z });
      },
    },
    {
      id: 'away',
      text: 'scenario.restore.away',
      hint: 'scenario.restore.away.hint',
      holds: (world, due) => world.space !== SCENARIO_LAYOUT && world.switches > last(due).switches,
      show: () => command('reference.space.switch', { name: AWAY_SPACE }),
    },
    {
      id: 'back',
      text: 'scenario.restore.back',
      hint: 'scenario.restore.back.hint',
      // Shown again since the step became due, as it was left: the world the step before became
      // due in, just after the change.
      holds: (world, due) => {
        const left = due.at(-2);
        if (left === undefined) {
          throw new Error('the back step follows the away step');
        }
        return (
          world.space === SCENARIO_LAYOUT &&
          world.switches > last(due).switches &&
          sameLayout(world.scene, left.scene)
        );
      },
      show: () => command('reference.space.switch', { name: SCENARIO_LAYOUT }),
    },
  ],
};

export const SCENARIOS: Readonly<Record<ScenarioId, Scenario>> = Object.freeze({
  behind,
  hidden,
  depth,
  focus,
  compose,
  restore,
});

/** A scenario under way: which, and how many of its steps are done. */
export interface ScenarioStatus {
  readonly scenario: ScenarioId;
  readonly steps: number;
  readonly done: number;
  readonly finished: boolean;
}

export interface Scenarios {
  /** The scenario under way, or null. */
  status(): ScenarioStatus | null;
  subscribe(listener: () => void): () => void;
  /**
   * Starts a scenario in place of any under way, its first step due: the caller has made the
   * studio and turned its features on.
   */
  start(id: ScenarioId): void;
  /** Stops the scenario under way. Throws when there is none. */
  stop(): void;
  /** Looks at the application again, ticking off the step due if it is done. */
  observe(): Promise<void>;
  /** How the application does the step due, from the world now; null when none is due. */
  demonstration(): Promise<Demonstration | null>;
  dispose(): void;
}

export interface ScenariosOptions {
  /** The application as a step's condition reads it, now. */
  readonly world: () => Promise<ScenarioWorld>;
}

export function createScenarios(options: ScenariosOptions): Scenarios {
  let guide: Lean.Guide | null = null;
  /** The world each step so far became due in, in order. */
  let due: ScenarioWorld[] = [];
  let disposed = false;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const step = (event: Lean.GuideEvent): Lean.Guide | null => {
    const answer = models.guideStep(guide, event);
    switch (answer.kind) {
      case 'next':
        return answer.guide;
      case 'noSteps':
        throw new Error('a scenario has steps');
      case 'notRunning':
        throw new Error('no scenario is under way');
    }
  };
  const scenarioOf = (g: Lean.Guide): Scenario => {
    const scenario = SCENARIOS[g.scenario as ScenarioId] as Scenario | undefined;
    if (scenario === undefined) {
      throw new Error(`no scenario "${g.scenario}"`);
    }
    return scenario;
  };
  /** Each look waits for the one before: the world is read and the step weighed in order. */
  let looking: Promise<void> = Promise.resolve();
  /** Rises with each start and stop, so a look begun before one is dropped. */
  let generation = 0;
  const look = async (): Promise<void> => {
    const g = guide;
    // Each step done so far, and the one due, has the world it became due in: until the one due
    // has its own (a scenario just started), there is nothing to weigh it against.
    if (g === null || disposed || g.done >= g.steps || due.length !== Number(g.done) + 1) {
      return;
    }
    const began = generation;
    const world = await options.world();
    if (began !== generation || guide !== g) {
      return;
    }
    // One change can do more than the step due (going to a window both selects it and turns the
    // camera to it): each step it did is ticked off, in order. A step weighed against the world it
    // became due in (one that asks for a change since) is not done by that same world.
    let advanced = false;
    for (;;) {
      const now = guide;
      if (now.done >= now.steps) {
        break;
      }
      const current = scenarioOf(now).steps[Number(now.done)];
      if (current === undefined) {
        throw new Error(`scenario "${now.scenario}" has no step ${String(now.done)}`);
      }
      const next = step({ kind: 'observe', holds: current.holds(world, due) });
      if (next === null || next.done === now.done) {
        break;
      }
      guide = next;
      // The next step becomes due in the world that did this one.
      due = [...due, world];
      advanced = true;
    }
    if (advanced) {
      tell();
    }
  };
  return Object.freeze({
    status() {
      return guide === null
        ? null
        : Object.freeze({
            scenario: guide.scenario as ScenarioId,
            steps: Number(guide.steps),
            done: Number(guide.done),
            finished: guide.done >= guide.steps,
          });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(id: ScenarioId) {
      const scenario = SCENARIOS[id];
      generation += 1;
      guide = step({ kind: 'start', scenario: id, steps: BigInt(scenario.steps.length) });
      due = [];
      tell();
      const began = generation;
      looking = looking
        .then(async () => {
          const world = await options.world();
          if (began === generation) {
            due = [world];
          }
        })
        .then(look);
    },
    stop() {
      generation += 1;
      guide = step({ kind: 'stop' });
      due = [];
      tell();
    },
    observe() {
      looking = looking.then(look);
      return looking;
    },
    async demonstration() {
      await looking;
      const g = guide;
      if (g === null || g.done >= g.steps) {
        return null;
      }
      const current = scenarioOf(g).steps[Number(g.done)];
      if (current === undefined) {
        throw new Error(`scenario "${g.scenario}" has no step ${String(g.done)}`);
      }
      return current.show(await options.world());
    },
    dispose() {
      disposed = true;
      generation += 1;
      listeners.clear();
    },
  });
}
