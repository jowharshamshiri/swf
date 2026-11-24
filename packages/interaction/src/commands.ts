import type {
  CancelReason,
  Id,
  JsonValue,
  NodeRecord,
  PreviewApplied,
  SceneState,
  TxOutcome,
  TxResult,
  WorkspaceMutator,
  WorkspaceReader,
} from '@swf/core';
import { effectiveState, makeError, SwfFailure } from '@swf/core';
import type { Transform3D, Vec3 } from '@swf/math';
import { add, scale, sub } from '@swf/math';
import type { ViewGeometry } from '@swf/presentation';
import { cameraRotation, headingPitchOf } from '@swf/projections';
import { placementOf, translatedBy, turnedAbout, withDepth, worldOrigin } from './drag.js';
import type { InteractionSettings } from './settings.js';

/** What a command can use. */
export interface CommandContext {
  readonly workspace: WorkspaceReader & WorkspaceMutator;
  readonly settings: InteractionSettings;
  /** The view of a viewport in the current scene; throws `UNKNOWN_ENTITY` for an unknown one. */
  view(viewportId: Id): ViewGeometry;
  /** Cancels every gesture in progress; returns how many there were. */
  cancelGestures(reason: CancelReason): number;
  /**
   * Picks a node up from the keyboard in a viewport: until it is put down or cancelled, the
   * commands that move, turn and resize it preview instead of committing.
   */
  hold(viewportId: Id, nodeId: Id): CommandOutcome;
  /** Puts the held node down: what its preview shows is committed once. */
  putDown(): CommandOutcome;
}

/** How a command ended: `previewed` when it changed only what a held node's preview shows. */
export type CommandOutcome =
  | TxOutcome
  | PreviewApplied
  | { readonly status: 'cancelled'; readonly count: number }
  | { readonly status: 'unchanged'; readonly reason: string };

/**
 * A spatial operation by name. Keyboard bindings, controls and programs run commands; every pointer
 * gesture names the command that does the same thing, so nothing needs pointer precision.
 */
export interface InteractionCommand {
  /** A stable command ID such as `node.move`. */
  readonly id: string;
  /** Runs it. Throws {@link SwfFailure} (`INVALID_INPUT`) naming the argument at fault. */
  run(args: JsonValue, context: CommandContext): CommandOutcome;
}

const COMMAND_ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** Why a value is not a valid command, or null. */
export function commandIssue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return 'a command must be an object';
  }
  const c = value as Partial<InteractionCommand>;
  if (typeof c.id !== 'string' || !COMMAND_ID.test(c.id)) {
    return `a command ID must look like "node.move" (got ${JSON.stringify(c.id)})`;
  }
  return typeof c.run === 'function' ? null : `command "${c.id}" must implement run()`;
}

class Args {
  readonly #record: Readonly<Record<string, JsonValue>>;
  readonly #command: string;

  constructor(command: string, args: JsonValue, allowed: readonly string[]) {
    this.#command = command;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw this.#fail('args', 'must be an object');
    }
    const record = args as Readonly<Record<string, JsonValue>>;
    const extra = Object.keys(record).find((k) => !allowed.includes(k));
    if (extra !== undefined) {
      throw this.#fail(extra, 'is not an argument of this command');
    }
    this.#record = record;
  }

  number(key: string, fallback: number): number {
    const value = this.#record[key];
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw this.#fail(key, 'must be a finite number');
    }
    return value;
  }

  id(key: string): Id | undefined {
    const value = this.#record[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw this.#fail(key, 'must be a non-blank ID');
    }
    return value;
  }

  nullableId(key: string): Id | null {
    const value = this.#record[key];
    if (value === null) {
      return null;
    }
    const id = this.id(key);
    if (id === undefined) {
      throw this.#fail(key, 'is required (an ID or null)');
    }
    return id;
  }

  ids(key: string): Id[] {
    const value = this.#record[key];
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim() !== '')) {
      throw this.#fail(key, 'must be an array of IDs');
    }
    return [...(value as string[])];
  }

  requiredId(key: string): Id {
    const id = this.id(key);
    if (id === undefined) {
      throw this.#fail(key, 'is required');
    }
    return id;
  }

  #fail(key: string, message: string): SwfFailure {
    return new SwfFailure(
      makeError('INVALID_INPUT', `command ${this.#command}: ${key} ${message}`, {
        path: `args.${key}`,
      }),
    );
  }
}

function settle(result: TxResult): TxOutcome {
  if (result.status === 'queued') {
    throw new SwfFailure(
      makeError(
        'INVALID_TRANSITION',
        'interaction commands cannot run inside a workspace event listener',
      ),
    );
  }
  return result;
}

const user = { source: 'user' } as const;

/** The node a command acts on: the one named, or else the first selected one. */
function subject(args: Args, scene: SceneState): Id | null {
  return args.id('nodeId') ?? scene.selection[0] ?? null;
}

/** The camera position of a view. */
export const eyeOf = (view: ViewGeometry): Vec3 => [
  view.camera[12],
  view.camera[13],
  view.camera[14],
];

const NOTHING_SELECTED = { status: 'unchanged', reason: 'no node is named or selected' } as const;
const PARENT_SINGULAR = {
  status: 'unchanged',
  reason: 'the node’s parent placement cannot be inverted',
} as const;

/**
 * The world translation for moving `right` and `up` along the camera's axes and `depth` along
 * the line from the camera to `point`, never bringing it nearer than `minDistance`.
 */
export function cameraRelativeDelta(
  view: ViewGeometry,
  point: Vec3,
  right: number,
  up: number,
  depth: number,
  minDistance: number,
): Vec3 {
  const c = view.camera;
  const lateral = add(scale([c[0], c[1], c[2]], right), scale([c[4], c[5], c[6]], up));
  const moved = add(point, lateral);
  return sub(depth === 0 ? moved : withDepth(eyeOf(view), moved, depth, minDistance), point);
}

function selectable(scene: SceneState): Id[] {
  const order: Id[] = [];
  const visit = (id: Id) => {
    const node = scene.nodes.get(id);
    if (node === undefined) {
      return;
    }
    if (effectiveState(scene.nodes, id)?.selectable === true) {
      order.push(id);
    }
    node.childIds.forEach(visit);
  };
  scene.rootIds.forEach(visit);
  return order;
}

function cycleSelection(step: 1 | -1): InteractionCommand {
  return {
    id: step === 1 ? 'selection.next' : 'selection.previous',
    run(args, ctx) {
      new Args(this.id, args, []);
      const scene = ctx.workspace.getState();
      const order = selectable(scene);
      if (order.length === 0) {
        return { status: 'unchanged', reason: 'nothing can be selected' };
      }
      const current = scene.selection[0];
      const index = current === undefined ? -1 : order.indexOf(current);
      const next =
        index < 0
          ? step === 1
            ? order[0]
            : order[order.length - 1]
          : order[(index + step + order.length) % order.length];
      if (next === undefined) {
        throw new Error('selection cycling left the list of selectable nodes');
      }
      return settle(ctx.workspace.transaction([{ type: 'selection.set', ids: [next] }], user));
    },
  };
}

/** A change to one node's placement or size, as a `node.patch` makes it. */
export interface NodeChange {
  readonly transform?: Transform3D;
  readonly bounds?: Vec3;
}

type Unchanged = Extract<CommandOutcome, { status: 'unchanged' }>;

/** A command that changes one node: how it reads its arguments and what it makes of them. */
interface NodeOperation<P> {
  readonly allowed: readonly string[];
  /** Reads the arguments, checking each, whether or not there is a node to act on. */
  parse(args: Args): P;
  /** What the operation changes on the node as it is in `scene`. */
  propose(
    params: P,
    scene: SceneState,
    node: NodeRecord,
    ctx: CommandContext,
  ): NodeChange | Unchanged;
}

const requireNode = (scene: SceneState, nodeId: Id): NodeRecord => {
  const node = scene.nodes.get(nodeId);
  if (node === undefined) {
    throw new SwfFailure(
      makeError('UNKNOWN_ENTITY', `no node "${nodeId}" in this workspace`, { entityId: nodeId }),
    );
  }
  return node;
};

const NODE_OPERATIONS = {
  // Moves a node along the camera's right and up axes and in depth along the line from the
  // camera: what a window drag and a depth gesture do, without a pointer.
  'node.move': {
    allowed: ['nodeId', 'viewportId', 'right', 'up', 'depth'],
    parse: (a: Args) => ({
      viewportId: a.requiredId('viewportId'),
      right: a.number('right', 0),
      up: a.number('up', 0),
      depth: a.number('depth', 0),
    }),
    propose(p, scene, node, ctx) {
      if (!node.flags.draggable) {
        return { status: 'unchanged', reason: `node "${node.id}" cannot be moved` };
      }
      const view = ctx.view(p.viewportId);
      const start = placementOf(scene, node.id);
      const delta = cameraRelativeDelta(
        view,
        worldOrigin(start),
        p.right,
        p.up,
        p.depth,
        ctx.settings.minDistance,
      );
      const transform = translatedBy(start, delta);
      return transform === null ? PARENT_SINGULAR : { transform };
    },
  } satisfies NodeOperation<{ viewportId: Id; right: number; up: number; depth: number }>,
  // Turns a node about the world vertical through its origin.
  'node.rotate': {
    allowed: ['nodeId', 'yaw'],
    parse: (a: Args) => a.number('yaw', 0),
    propose(yaw, scene, node) {
      if (!node.flags.rotatable) {
        return { status: 'unchanged', reason: `node "${node.id}" cannot be rotated` };
      }
      const start = placementOf(scene, node.id);
      const transform = turnedAbout(start, worldOrigin(start), yaw);
      return transform === null ? PARENT_SINGULAR : { transform };
    },
  } satisfies NodeOperation<number>,
  // Changes a node's width and height, keeping its centre.
  'node.resize': {
    allowed: ['nodeId', 'width', 'height'],
    parse: (a: Args) => [a.number('width', 0), a.number('height', 0)] as const,
    propose([dw, dh], _scene, node, ctx) {
      if (!node.flags.resizable) {
        return { status: 'unchanged', reason: `node "${node.id}" cannot be resized` };
      }
      const min = ctx.settings.minSize;
      const [w, h, d] = node.bounds;
      return { bounds: [Math.max(min, w + dw), Math.max(min, h + dh), d] };
    },
  } satisfies NodeOperation<readonly [number, number]>,
} as const;

type NodeOperationId = keyof typeof NODE_OPERATIONS;

function operationOf(id: NodeOperationId): NodeOperation<unknown> {
  return NODE_OPERATIONS[id];
}

/** A command that changes one node, committing at once. */
function nodeCommand(id: NodeOperationId): InteractionCommand {
  const operation = operationOf(id);
  return {
    id,
    run(args, ctx) {
      const a = new Args(id, args, operation.allowed);
      const params = operation.parse(a);
      const scene = ctx.workspace.getState();
      const nodeId = subject(a, scene);
      if (nodeId === null) {
        return NOTHING_SELECTED;
      }
      const change = operation.propose(params, scene, requireNode(scene, nodeId), ctx);
      return 'status' in change
        ? change
        : settle(ctx.workspace.transaction([{ type: 'node.patch', id: nodeId, ...change }], user));
    },
  };
}

/**
 * What a command does to a held node, worked out on `scene` (the node as its hold shows it); null
 * when the command is not one that moves, turns or resizes a node, or names another node, and so
 * runs as it always does.
 */
export function heldChange(
  id: string,
  args: JsonValue,
  scene: SceneState,
  heldId: Id,
  ctx: CommandContext,
): NodeChange | Unchanged | null {
  if (!Object.hasOwn(NODE_OPERATIONS, id)) {
    return null;
  }
  const operation = operationOf(id as NodeOperationId);
  const a = new Args(id, args, operation.allowed);
  const params = operation.parse(a);
  const named = a.id('nodeId');
  if (named !== undefined && named !== heldId) {
    return null;
  }
  return operation.propose(params, scene, requireNode(scene, heldId), ctx);
}

/** The commands every router offers. */
export const BUILT_IN_COMMANDS: readonly InteractionCommand[] = Object.freeze([
  {
    id: 'selection.set',
    run(args, ctx) {
      const a = new Args(this.id, args, ['ids']);
      return settle(
        ctx.workspace.transaction([{ type: 'selection.set', ids: a.ids('ids') }], user),
      );
    },
  },
  cycleSelection(1),
  cycleSelection(-1),
  {
    id: 'focus.set',
    run(args, ctx) {
      const a = new Args(this.id, args, ['nodeId']);
      return settle(
        ctx.workspace.transaction([{ type: 'focus.set', id: a.nullableId('nodeId') }], user),
      );
    },
  },
  {
    id: 'focus.selected',
    run(args, ctx) {
      new Args(this.id, args, []);
      const selected = ctx.workspace.getState().selection[0];
      return selected === undefined
        ? NOTHING_SELECTED
        : settle(ctx.workspace.transaction([{ type: 'focus.set', id: selected }], user));
    },
  },
  nodeCommand('node.move'),
  nodeCommand('node.rotate'),
  nodeCommand('node.resize'),
  {
    // Turns a viewport's camera: what a background drag does in camera navigation.
    id: 'camera.turn',
    run(args, ctx) {
      const a = new Args(this.id, args, ['viewportId', 'heading', 'pitch']);
      const scene = ctx.workspace.getState();
      const viewport = scene.viewports.get(a.requiredId('viewportId'));
      const camera = viewport === undefined ? undefined : scene.cameras.get(viewport.cameraId);
      if (viewport === undefined || camera === undefined) {
        throw new SwfFailure(
          makeError('UNKNOWN_ENTITY', `no viewport "${String(a.id('viewportId'))}"`, {
            path: 'args.viewportId',
          }),
        );
      }
      const { heading, pitch } = headingPitchOf(camera.rotation);
      const nextPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch + a.number('pitch', 0)));
      return settle(
        ctx.workspace.transaction(
          [
            {
              type: 'camera.patch',
              id: camera.id,
              rotation: cameraRotation(heading + a.number('heading', 0), nextPitch),
            },
          ],
          user,
        ),
      );
    },
  },
  {
    // Turns the orbit root about the vertical through a viewport's camera: what a background drag
    // does in orbit navigation. Undoable, unlike turning the camera.
    id: 'orbit.turn',
    run(args, ctx) {
      const a = new Args(this.id, args, ['viewportId', 'angle']);
      const angle = a.number('angle', 0);
      const scene = ctx.workspace.getState();
      const view = ctx.view(a.requiredId('viewportId'));
      const rootId = scene.orbitRootId;
      if (rootId === null) {
        return { status: 'unchanged', reason: 'the workspace has no orbit root' };
      }
      const transform = turnedAbout(placementOf(scene, rootId), eyeOf(view), angle);
      if (transform === null) {
        return PARENT_SINGULAR;
      }
      return settle(
        ctx.workspace.transaction([{ type: 'node.patch', id: rootId, transform }], user),
      );
    },
  },
  {
    id: 'history.undo',
    run(args, ctx) {
      new Args(this.id, args, []);
      return settle(ctx.workspace.undo(user));
    },
  },
  {
    id: 'history.redo',
    run(args, ctx) {
      new Args(this.id, args, []);
      return settle(ctx.workspace.redo(user));
    },
  },
  {
    // Picks the named or selected node up from the keyboard.
    id: 'gesture.grab',
    run(args, ctx) {
      const a = new Args(this.id, args, ['viewportId', 'nodeId']);
      const viewportId = a.requiredId('viewportId');
      const nodeId = subject(a, ctx.workspace.getState());
      return nodeId === null ? NOTHING_SELECTED : ctx.hold(viewportId, nodeId);
    },
  },
  {
    id: 'gesture.drop',
    run(args, ctx) {
      new Args(this.id, args, []);
      return ctx.putDown();
    },
  },
  {
    id: 'gesture.cancel',
    run(args, ctx) {
      new Args(this.id, args, []);
      return { status: 'cancelled', count: ctx.cancelGestures('host') };
    },
  },
]);
