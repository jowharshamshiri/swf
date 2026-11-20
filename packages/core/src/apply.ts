import type { Aabb, Mat4, Transform3D, Vec3 } from '@swf/math';
import {
  aabbCenter,
  aabbOfBox,
  aabbUnion,
  IDENTITY_QUAT,
  IDENTITY_TRANSFORM,
  mat4Decompose,
  mat4FromTransform,
  mat4InvertAffine,
  mat4Multiply,
  ONE_VEC3,
} from '@swf/math';
import type { EventSource, KeepMode, SceneCommandType } from './commands.js';
import { SCENE_COMMAND_TYPES } from './commands.js';
import type { Constraint } from './constraints.js';
import { resolveConstraints } from './constraints.js';
import { RejectionSignal } from './errors.js';
import type { Metadata } from './json.js';
import { checkMetadataKey, copyMetadata, describe } from './json.js';
import type { Id, NodeRecord, SceneState } from './model.js';
import { DEFAULT_NODE_FLAGS } from './model.js';
import {
  ancestorIds,
  descendantIds,
  effectiveState,
  isSelfOrAncestor,
  parentWorldMatrix,
  worldMatrix,
} from './query.js';
import type { TableDraft } from './table.js';
import {
  expectBounds,
  expectFlags,
  expectId,
  expectIdList,
  expectIdOrNull,
  expectIndex,
  expectLabel,
  expectNonBlank,
  expectRecord,
  expectTags,
  expectTransform,
  invalid,
} from './validate.js';

export interface ApplyContext {
  readonly source: EventSource;
  readonly now: number;
  /** Supplies a fresh ID, given a test for IDs in use; the draft rejects one already in use. */
  readonly createId: (inUse: (id: Id) => boolean) => Id;
  /** Sorted constraints to resolve placements through. */
  readonly constraints: readonly Constraint[];
}

/** The scene after applying commands, before the revision is advanced. */
export interface ApplyOutcome {
  readonly nodes: SceneState['nodes'];
  readonly rootIds: readonly Id[];
  readonly selection: readonly Id[];
  readonly focusedId: Id | null;
  readonly commandTypes: readonly SceneCommandType[];
  /** Nodes created, changed or removed, in the order they were first touched. */
  readonly touched: readonly Id[];
  readonly createdIds: readonly Id[];
}

/**
 * Applies `commands` to `base` as one unit: every command is validated against the scene as the
 * earlier commands left it, then the placements they proposed are resolved through the
 * constraints. Throws a {@link RejectionSignal} on the first failure; `base` is never modified.
 */
export function applyCommands(
  base: SceneState,
  commands: unknown,
  ctx: ApplyContext,
): ApplyOutcome {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw invalid('commands', 'must be a non-empty array of scene commands');
  }
  const draft = new Draft(base, ctx);
  for (const [i, command] of commands.entries()) {
    draft.apply(command, `commands[${i}]`);
  }
  return draft.finish();
}

type MutableRecord = { -readonly [K in keyof NodeRecord]: NodeRecord[K] };

class Draft {
  readonly #base: SceneState;
  readonly #ctx: ApplyContext;
  readonly #nodes: TableDraft<NodeRecord>;
  #rootIds: readonly Id[];
  #selection: readonly Id[];
  #focusedId: Id | null;
  readonly #commandTypes: SceneCommandType[] = [];
  readonly #touched = new Set<Id>();
  /** Nodes whose placement was proposed in this transaction: constraints resolve these. */
  readonly #placed = new Set<Id>();
  readonly #created: Id[] = [];

  constructor(base: SceneState, ctx: ApplyContext) {
    this.#base = base;
    this.#ctx = ctx;
    this.#nodes = base.nodes.edit();
    this.#rootIds = base.rootIds;
    this.#selection = base.selection;
    this.#focusedId = base.focusedId;
  }

  apply(raw: unknown, path: string): void {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw invalid(path, `must be a scene command object (got ${describe(raw)})`);
    }
    const type = (raw as { type?: unknown }).type;
    if (!isCommandType(type)) {
      throw invalid(
        `${path}.type`,
        `must be one of ${SCENE_COMMAND_TYPES.join(', ')} (got ${describe(type)})`,
      );
    }
    const command = expectRecord(raw, path, ['type', ...COMMAND_FIELDS[type]]);
    this.#commandTypes.push(type);
    switch (type) {
      case 'node.create':
        this.#create(command['node'], `${path}.node`);
        return;
      case 'node.patch':
        this.#patch(command, path);
        return;
      case 'node.reparent':
        this.#reparent(command, path);
        return;
      case 'node.reorder':
        this.#reorder(command, path);
        return;
      case 'node.duplicate':
        this.#duplicate(command, path);
        return;
      case 'node.archive':
        this.#setStatus(command, path, 'archived');
        return;
      case 'node.restoreArchived':
        this.#setStatus(command, path, 'active');
        return;
      case 'node.delete':
        this.#delete(command, path);
        return;
      case 'node.group':
        this.#group(command, path);
        return;
      case 'node.ungroup':
        this.#ungroup(command, path);
        return;
      case 'selection.set': {
        const ids = expectIdList(command['ids'], `${path}.ids`);
        ids.forEach((id, i) => {
          this.#assertSelectable(id, `${path}.ids[${i}]`);
        });
        this.#selection = ids;
        return;
      }
      case 'focus.set': {
        const id = expectIdOrNull(command['id'], `${path}.id`);
        if (id !== null) {
          this.#assertSelectable(id, `${path}.id`);
        }
        this.#focusedId = id;
        return;
      }
    }
  }

  finish(): ApplyOutcome {
    this.#resolveConstraints();
    // Nodes removed, archived or hidden by this transaction leave the selection and focus.
    const stillSelectable = (id: Id) => effectiveState(this.#nodes, id)?.selectable === true;
    const selection = this.#selection.filter(stillSelectable);
    const focusedId =
      this.#focusedId !== null && stillSelectable(this.#focusedId) ? this.#focusedId : null;
    return {
      nodes: this.#nodes.freeze(),
      rootIds: this.#rootIds,
      selection:
        selection.length === this.#selection.length ? this.#selection : Object.freeze(selection),
      focusedId,
      commandTypes: Object.freeze([...this.#commandTypes]),
      touched: Object.freeze([...this.#touched]),
      createdIds: Object.freeze([...this.#created]),
    };
  }

  // --- commands ---------------------------------------------------------------------------

  #create(raw: unknown, path: string): void {
    const spec = expectRecord(raw, path, NODE_SPEC_FIELDS);
    const id =
      spec['id'] === undefined
        ? this.#freshId(`${path}.id`)
        : this.#unusedId(spec['id'], `${path}.id`);
    const parentId =
      spec['parentId'] === undefined ? null : expectIdOrNull(spec['parentId'], `${path}.parentId`);
    if (parentId !== null) {
      this.#require(parentId, `${path}.parentId`);
    }
    this.#put({
      id,
      kind: expectNonBlank(spec['kind'], `${path}.kind`),
      parentId,
      childIds: EMPTY,
      transform:
        spec['transform'] === undefined
          ? IDENTITY_TRANSFORM
          : expectTransform(spec['transform'], `${path}.transform`),
      bounds: expectBounds(spec['bounds'], `${path}.bounds`),
      flags:
        spec['flags'] === undefined
          ? DEFAULT_NODE_FLAGS
          : Object.freeze({
              ...DEFAULT_NODE_FLAGS,
              ...expectFlags(spec['flags'], `${path}.flags`),
            }),
      label: spec['label'] === undefined ? null : expectLabel(spec['label'], `${path}.label`),
      tags: spec['tags'] === undefined ? EMPTY : expectTags(spec['tags'], `${path}.tags`),
      metadata:
        spec['metadata'] === undefined
          ? EMPTY_METADATA
          : copyMetadata(spec['metadata'], `${path}.metadata`),
      status: 'active',
      createdAt: this.#ctx.now,
      updatedAt: this.#ctx.now,
    });
    this.#insertChild(parentId, id, spec['index'], `${path}.index`);
    this.#created.push(id);
    this.#placed.add(id);
  }

  #patch(command: Record<string, unknown>, path: string): void {
    const node = this.#require(command['id'], `${path}.id`);
    const next: MutableRecord = { ...node, updatedAt: this.#ctx.now };
    if (command['transform'] !== undefined) {
      this.#assertUnlocked(node, path, 'move');
      next.transform = expectTransform(command['transform'], `${path}.transform`);
      this.#placed.add(node.id);
    }
    if (command['bounds'] !== undefined) {
      this.#assertUnlocked(node, path, 'resize');
      next.bounds = expectBounds(command['bounds'], `${path}.bounds`);
    }
    if (command['label'] !== undefined) {
      next.label = expectLabel(command['label'], `${path}.label`);
    }
    if (command['tags'] !== undefined) {
      next.tags = expectTags(command['tags'], `${path}.tags`);
    }
    if (command['flags'] !== undefined) {
      next.flags = Object.freeze({
        ...node.flags,
        ...expectFlags(command['flags'], `${path}.flags`),
      });
    }
    if (command['metadata'] !== undefined) {
      next.metadata = patchMetadata(node.metadata, command['metadata'], `${path}.metadata`);
    }
    this.#put(next);
  }

  #reparent(command: Record<string, unknown>, path: string): void {
    const node = this.#require(command['id'], `${path}.id`);
    const parentId = expectIdOrNull(command['parentId'], `${path}.parentId`);
    if (parentId !== null) {
      this.#require(parentId, `${path}.parentId`);
      if (isSelfOrAncestor(this.#nodes, node.id, parentId)) {
        throw invalid(`${path}.parentId`, `would make "${node.id}" its own ancestor`);
      }
    }
    this.#assertUnlocked(node, path, 'be reparented');
    const keep: unknown = command['keep'] ?? (this.#ctx.source === 'user' ? 'world' : 'local');
    if (keep !== 'world' && keep !== 'local') {
      throw invalid(`${path}.keep`, `must be "world" or "local" (got ${describe(keep)})`);
    }
    this.#moveTo(node.id, parentId, keep, command['index'], `${path}.index`, path);
  }

  #reorder(command: Record<string, unknown>, path: string): void {
    const node = this.#require(command['id'], `${path}.id`);
    this.#insertChild(node.parentId, node.id, command['index'], `${path}.index`);
  }

  #duplicate(command: Record<string, unknown>, path: string): void {
    const source = this.#require(command['id'], `${path}.id`);
    if (effectiveState(this.#nodes, source.id)?.active !== true) {
      throw invalid(`${path}.id`, `names archived node "${source.id}", which cannot be duplicated`);
    }
    const subtree = [source.id, ...this.#activeDescendants(source.id)];
    const chosen =
      command['ids'] === undefined ? {} : expectRecord(command['ids'], `${path}.ids`, subtree);
    const mapping = new Map<Id, Id>();
    const used = new Set<Id>();
    for (const id of subtree) {
      const wanted = chosen[id];
      const copyId =
        wanted === undefined
          ? this.#freshId(`${path}.ids`)
          : this.#unusedId(wanted, `${path}.ids.${id}`);
      if (used.has(copyId)) {
        throw invalid(`${path}.ids.${id}`, `repeats the ID "${copyId}"`);
      }
      used.add(copyId);
      mapping.set(id, copyId);
    }
    const parentId =
      command['parentId'] === undefined
        ? source.parentId
        : expectIdOrNull(command['parentId'], `${path}.parentId`);
    if (parentId !== null) {
      this.#require(parentId, `${path}.parentId`);
    }
    const rootTransform =
      command['transform'] === undefined
        ? source.transform
        : expectTransform(command['transform'], `${path}.transform`);
    const mapped = (id: Id): Id => {
      const copy = mapping.get(id);
      if (copy === undefined) {
        throw new Error(`duplicate: no copy mapped for "${id}"`);
      }
      return copy;
    };
    for (const id of subtree) {
      const original = this.#require(id, `${path}.id`);
      const isRoot = id === source.id;
      this.#put({
        ...original,
        id: mapped(id),
        parentId: isRoot ? parentId : mapped(original.parentId ?? ''),
        childIds: Object.freeze(original.childIds.filter((c) => mapping.has(c)).map(mapped)),
        transform: isRoot ? rootTransform : original.transform,
        status: 'active',
        createdAt: this.#ctx.now,
        updatedAt: this.#ctx.now,
      });
      this.#created.push(mapped(id));
      this.#placed.add(mapped(id));
    }
    this.#insertChild(parentId, mapped(source.id), undefined, `${path}.parentId`);
  }

  #setStatus(command: Record<string, unknown>, path: string, status: NodeRecord['status']): void {
    const node = this.#require(command['id'], `${path}.id`);
    if (node.status === status) {
      throw invalid(`${path}.id`, `names node "${node.id}", which is already ${status}`);
    }
    this.#assertUnlocked(node, path, status === 'archived' ? 'be archived' : 'be restored');
    this.#put({ ...node, status, updatedAt: this.#ctx.now });
  }

  #delete(command: Record<string, unknown>, path: string): void {
    const node = this.#require(command['id'], `${path}.id`);
    const mode: unknown = command['mode'];
    if (mode !== 'subtree' && mode !== 'detachChildren' && mode !== 'rejectIfChildren') {
      throw invalid(
        `${path}.mode`,
        `must be "subtree", "detachChildren" or "rejectIfChildren" (got ${describe(mode)})`,
      );
    }
    this.#assertUnlocked(node, path, 'be deleted');
    if (mode === 'rejectIfChildren' && node.childIds.length > 0) {
      throw invalid(
        `${path}.id`,
        `names node "${node.id}", which still has ${node.childIds.length} children`,
      );
    }
    if (mode === 'subtree') {
      const descendants = descendantIds(this.#nodes, node.id);
      for (const id of descendants) {
        this.#assertUnlocked(this.#require(id, path), path, 'be deleted');
      }
      for (const id of descendants) {
        this.#remove(id);
      }
    } else {
      this.#dissolve(node.id, path);
    }
    this.#detachFromParent(node.id);
    this.#remove(node.id);
  }

  #group(command: Record<string, unknown>, path: string): void {
    const memberIds = expectIdList(command['nodeIds'], `${path}.nodeIds`);
    if (memberIds.length === 0) {
      throw invalid(`${path}.nodeIds`, 'must list at least one node');
    }
    const members = memberIds.map((id, i) => {
      const member = this.#require(id, `${path}.nodeIds[${i}]`);
      this.#assertUnlocked(member, `${path}.nodeIds[${i}]`, 'be grouped');
      return member;
    });
    members.forEach((a, i) => {
      const container = members.find((b) => a !== b && isSelfOrAncestor(this.#nodes, b.id, a.id));
      if (container !== undefined) {
        throw invalid(
          `${path}.nodeIds[${i}]`,
          `names "${a.id}", which is inside member "${container.id}"`,
        );
      }
    });
    const spec =
      command['group'] === undefined
        ? {}
        : expectRecord(command['group'], `${path}.group`, GROUP_FIELDS);
    const parentId = this.#groupParent(members, spec['parentId'], `${path}.group.parentId`);
    const parentWorld = this.#parentWorld(parentId, path);
    const transform =
      spec['transform'] === undefined
        ? enclosingTransform(this.#membersBox(members, parentWorld, path))
        : expectTransform(spec['transform'], `${path}.group.transform`);
    const bounds =
      spec['bounds'] === undefined
        ? centredBounds(
            this.#membersBox(
              members,
              mat4Multiply(parentWorld, mat4FromTransform(transform)),
              path,
            ),
          )
        : expectBounds(spec['bounds'], `${path}.group.bounds`);
    const siblings = this.#children(parentId);
    const memberPositions = members.map((m) => siblings.indexOf(m.id)).filter((i) => i >= 0);
    const groupId =
      spec['id'] === undefined
        ? this.#freshId(`${path}.group.id`)
        : this.#unusedId(spec['id'], `${path}.group.id`);
    this.#put({
      id: groupId,
      kind:
        spec['kind'] === undefined ? 'group' : expectNonBlank(spec['kind'], `${path}.group.kind`),
      parentId,
      childIds: EMPTY,
      transform,
      bounds,
      flags: DEFAULT_NODE_FLAGS,
      label: spec['label'] === undefined ? null : expectLabel(spec['label'], `${path}.group.label`),
      tags: EMPTY,
      metadata: EMPTY_METADATA,
      status: 'active',
      createdAt: this.#ctx.now,
      updatedAt: this.#ctx.now,
    });
    // The group takes the place of its backmost member that shares its parent.
    this.#insertChild(
      parentId,
      groupId,
      memberPositions.length > 0 ? Math.min(...memberPositions) : undefined,
      `${path}.group`,
    );
    this.#created.push(groupId);
    this.#placed.add(groupId);
    for (const member of members) {
      this.#moveTo(member.id, groupId, 'world', undefined, path, path);
    }
  }

  #ungroup(command: Record<string, unknown>, path: string): void {
    const node = this.#require(command['id'], `${path}.id`);
    this.#assertUnlocked(node, path, 'be ungrouped');
    this.#dissolve(node.id, path);
    this.#detachFromParent(node.id);
    this.#remove(node.id);
  }

  // --- helpers ----------------------------------------------------------------------------

  #groupParent(members: readonly NodeRecord[], raw: unknown, path: string): Id | null {
    if (raw === undefined) {
      const parents = new Set(members.map((m) => m.parentId));
      const [only] = parents;
      if (parents.size !== 1 || only === undefined) {
        throw invalid(path, 'is required when the members do not share one parent');
      }
      return only;
    }
    const parentId = expectIdOrNull(raw, path);
    if (parentId !== null) {
      this.#require(parentId, path);
      const inside = members.find((m) => isSelfOrAncestor(this.#nodes, m.id, parentId));
      if (inside !== undefined) {
        throw invalid(path, `is inside member "${inside.id}"`);
      }
    }
    return parentId;
  }

  /** Moves the node's children to its parent at its position, keeping their world placement. */
  #dissolve(id: Id, path: string): void {
    const node = this.#require(id, path);
    let index = this.#children(node.parentId).indexOf(node.id);
    for (const childId of node.childIds) {
      this.#moveTo(childId, node.parentId, 'world', index, path, path);
      index += 1;
    }
  }

  #moveTo(
    id: Id,
    parentId: Id | null,
    keep: KeepMode,
    rawIndex: unknown,
    indexPath: string,
    path: string,
  ): void {
    const node = this.#require(id, path);
    let transform = node.transform;
    if (keep === 'world' && parentId !== node.parentId) {
      const world = worldMatrix(this.#nodes, id);
      const inverse = mat4InvertAffine(this.#parentWorld(parentId, path));
      const local =
        world === undefined || inverse === null
          ? null
          : mat4Decompose(mat4Multiply(inverse, world));
      if (!local?.ok) {
        const where = parentId === null ? 'as a root' : `under "${parentId}"`;
        const why = local === null ? 'is singular' : `has ${local.reason}`;
        throw invalid(
          path,
          `cannot keep the world placement of "${id}" ${where}: the result ${why}`,
        );
      }
      transform = freezeTransform(local.transform);
    }
    this.#detachFromParent(id);
    this.#put({ ...node, parentId, transform, updatedAt: this.#ctx.now });
    this.#insertChild(parentId, id, rawIndex, indexPath);
    this.#placed.add(id);
  }

  /** The members' combined box in the frame whose world matrix is `frame`. */
  #membersBox(members: readonly NodeRecord[], frame: Mat4, path: string): Aabb {
    const inverse = mat4InvertAffine(frame);
    if (inverse === null) {
      throw invalid(path, 'places the group in a singular frame');
    }
    const boxes = members.map((member) =>
      aabbOfBox(mat4Multiply(inverse, this.#worldOf(member.id, path)), member.bounds),
    );
    const [first, ...rest] = boxes;
    if (first === undefined) {
      throw invalid(path, 'has no members');
    }
    return rest.reduce(aabbUnion, first);
  }

  #worldOf(id: Id, path: string): Mat4 {
    const m = worldMatrix(this.#nodes, id);
    if (m === undefined) {
      throw this.#unknown(id, path);
    }
    return m;
  }

  #parentWorld(parentId: Id | null, path: string): Mat4 {
    const m = parentWorldMatrix(this.#nodes, parentId);
    if (m === undefined) {
      throw this.#unknown(parentId ?? '', path);
    }
    return m;
  }

  #assertSelectable(id: Id, path: string): void {
    this.#require(id, path);
    if (effectiveState(this.#nodes, id)?.selectable !== true) {
      throw invalid(path, `names "${id}", which is not active, visible and selectable`);
    }
  }

  #activeDescendants(id: Id): Id[] {
    const out: Id[] = [];
    const visit = (current: Id): void => {
      for (const child of this.#nodes.get(current)?.childIds ?? []) {
        if (this.#nodes.get(child)?.status === 'active') {
          out.push(child);
          visit(child);
        }
      }
    };
    visit(id);
    return out;
  }

  /**
   * Resolves every proposed placement through the constraints, ancestors before descendants so a
   * child is checked against its parent's final placement.
   */
  #resolveConstraints(): void {
    const constraints = this.#ctx.constraints;
    if (constraints.length === 0) {
      return;
    }
    const depth = (id: Id) => ancestorIds(this.#nodes, id).length;
    const order = [...this.#placed].filter((id) => this.#nodes.has(id));
    order.sort((a, b) => depth(a) - depth(b));
    for (const id of order) {
      const node = this.#require(id, `nodes.${id}`);
      const applicable = constraints.filter((c) => c.appliesTo === undefined || c.appliesTo(node));
      if (applicable.length === 0) {
        continue;
      }
      const result = resolveConstraints(
        applicable,
        {
          node,
          previous: this.#base.nodes.get(id),
          parentWorld: this.#parentWorld(node.parentId, `nodes.${id}`),
          nodes: this.#nodes,
          committedNodes: this.#base.nodes,
        },
        node.transform,
      );
      if (!result.ok) {
        throw new RejectionSignal(
          'CONSTRAINT_REJECTED',
          `constraint "${result.constraintId}" rejected the placement of "${id}": ${result.reason}`,
          { entityId: id, details: { constraintId: result.constraintId } },
        );
      }
      if (result.transform !== node.transform) {
        this.#put({ ...node, transform: freezeTransform(result.transform) });
      }
    }
  }

  #assertUnlocked(node: NodeRecord, path: string, action: string): void {
    if (this.#ctx.source === 'user' && node.flags.locked) {
      throw new RejectionSignal(
        'LOCKED',
        `${path}: node "${node.id}" is locked, so it cannot ${action}`,
        { path, entityId: node.id },
      );
    }
  }

  #require(raw: unknown, path: string): NodeRecord {
    const id = expectId(raw, path);
    const node = this.#nodes.get(id);
    if (node === undefined) {
      throw this.#unknown(id, path);
    }
    return node;
  }

  #unknown(id: Id, path: string): RejectionSignal {
    return new RejectionSignal('UNKNOWN_ENTITY', `${path}: no node "${id}" in this workspace`, {
      path,
      entityId: id,
    });
  }

  #unusedId(raw: unknown, path: string): Id {
    const id = expectId(raw, path);
    if (this.#nodes.has(id)) {
      throw invalid(path, `"${id}" is already in use in this workspace`);
    }
    return id;
  }

  #freshId(path: string): Id {
    return this.#unusedId(
      this.#ctx.createId((id) => this.#nodes.has(id)),
      `${path} (generated)`,
    );
  }

  #children(parentId: Id | null): Id[] {
    return [...(parentId === null ? this.#rootIds : this.#require(parentId, 'parent').childIds)];
  }

  #setChildren(parentId: Id | null, childIds: readonly Id[]): void {
    const frozen = Object.freeze([...childIds]);
    if (parentId === null) {
      this.#rootIds = frozen;
    } else {
      this.#put({
        ...this.#require(parentId, 'parent'),
        childIds: frozen,
        updatedAt: this.#ctx.now,
      });
    }
  }

  #detachFromParent(id: Id): void {
    const parentId = this.#require(id, 'node').parentId;
    this.#setChildren(
      parentId,
      this.#children(parentId).filter((child) => child !== id),
    );
  }

  /**
   * Places `id` among `parentId`'s children at `rawIndex` (omitted: last), moving it there if it
   * is already among them.
   */
  #insertChild(parentId: Id | null, id: Id, rawIndex: unknown, path: string): void {
    const siblings = this.#children(parentId).filter((child) => child !== id);
    const index =
      rawIndex === undefined ? siblings.length : expectIndex(rawIndex, path, siblings.length);
    siblings.splice(index, 0, id);
    this.#setChildren(parentId, siblings);
  }

  #put(record: NodeRecord): void {
    this.#nodes.set(record.id, Object.freeze(record));
    this.#touched.add(record.id);
  }

  #remove(id: Id): void {
    this.#nodes.delete(id);
    this.#touched.add(id);
    this.#placed.delete(id);
  }
}

function patchMetadata(current: Metadata, raw: unknown, path: string): Metadata {
  const patch = expectRecord(raw, path, ['set', 'remove']);
  const out = new Map(Object.entries(current));
  if (patch['set'] !== undefined) {
    for (const [key, value] of Object.entries(copyMetadata(patch['set'], `${path}.set`))) {
      out.set(key, value);
    }
  }
  if (patch['remove'] !== undefined) {
    if (!Array.isArray(patch['remove'])) {
      throw invalid(`${path}.remove`, 'must be an array of metadata keys');
    }
    for (const [i, key] of patch['remove'].entries()) {
      const name = expectNonBlank(key, `${path}.remove[${i}]`);
      checkMetadataKey(name, `${path}.remove[${i}]`);
      out.delete(name);
    }
  }
  return Object.freeze(Object.fromEntries(out));
}

/** A placement at the box's centre, axis-aligned with the frame the box is in. */
function enclosingTransform(box: Aabb): Transform3D {
  return Object.freeze({
    position: Object.freeze(aabbCenter(box)),
    rotation: IDENTITY_QUAT,
    scale: ONE_VEC3,
  });
}

/** The smallest bounds centred on the origin that contain the box. */
function centredBounds(box: Aabb): Vec3 {
  const half = (i: 0 | 1 | 2) => Math.max(Math.abs(box.min[i]), Math.abs(box.max[i]));
  return Object.freeze([2 * half(0), 2 * half(1), 2 * half(2)] as const);
}

function freezeTransform(t: Transform3D): Transform3D {
  return Object.freeze({
    position: Object.freeze([...t.position] as const),
    rotation: Object.freeze([...t.rotation] as const),
    scale: Object.freeze([...t.scale] as const),
  });
}

function isCommandType(value: unknown): value is SceneCommandType {
  return typeof value === 'string' && (SCENE_COMMAND_TYPES as readonly string[]).includes(value);
}

const EMPTY: readonly never[] = Object.freeze([]);
const EMPTY_METADATA: Metadata = Object.freeze({});

const NODE_SPEC_FIELDS = [
  'id',
  'kind',
  'parentId',
  'index',
  'transform',
  'bounds',
  'label',
  'tags',
  'flags',
  'metadata',
] as const;

const GROUP_FIELDS = ['id', 'kind', 'label', 'parentId', 'transform', 'bounds'] as const;

const COMMAND_FIELDS: Readonly<Record<SceneCommandType, readonly string[]>> = {
  'node.create': ['node'],
  'node.patch': ['id', 'transform', 'bounds', 'label', 'tags', 'flags', 'metadata'],
  'node.reparent': ['id', 'parentId', 'keep', 'index'],
  'node.reorder': ['id', 'index'],
  'node.duplicate': ['id', 'ids', 'parentId', 'transform'],
  'node.archive': ['id'],
  'node.restoreArchived': ['id'],
  'node.delete': ['id', 'mode'],
  'node.group': ['nodeIds', 'group'],
  'node.ungroup': ['id'],
  'selection.set': ['ids'],
  'focus.set': ['id'],
};
