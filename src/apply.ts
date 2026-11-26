import type { Aabb, Mat4, Transform3D, Vec3 } from '@swf/math';
import { models } from '@swf/models';
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
import type { EventSource, KeepMode, OperationType, SceneCommandType } from './commands.js';
import { SCENE_COMMAND_TYPES } from './commands.js';
import type { Constraint } from './constraints.js';
import { constraintApplies, resolveConstraints } from './constraints.js';
import { RejectionSignal, thrownText } from './errors.js';
import type { GeometryDescriptor, GeometryLimits, GeometryRegistry } from './geometry.js';
import { geometryParamsIssue, RECT_GEOMETRY } from './geometry.js';
import type { Metadata } from './json.js';
import { checkMetadataKey, copyJson, copyMetadata, describe } from './json.js';
import type {
  CameraRecord,
  Id,
  NavigationTarget,
  NodeRecord,
  ProjectionSetting,
  SceneState,
  SurfaceRecord,
  ViewportRecord,
} from './model.js';
import { DEFAULT_FLAGS } from './model.js';
import type { ProjectionKindRegistry } from './projection-kinds.js';
import { projectionConfigIssue } from './projection-kinds.js';
import {
  ancestorIds,
  descendantIds,
  effectiveState,
  parentWorldMatrix,
  worldMatrix,
} from './query.js';
import type { TableDraft } from './table.js';
import {
  expectBindingKey,
  expectBounds,
  expectFlags,
  expectId,
  expectIdList,
  expectIdOrNull,
  expectIndex,
  expectInteraction,
  expectLabel,
  expectNonBlank,
  expectPositive,
  expectRecord,
  expectRotation,
  expectTags,
  expectTransform,
  expectVec3,
  expectVersionedId,
  invalid,
} from './validate.js';

export interface ApplyContext {
  readonly source: EventSource;
  readonly now: number;
  /** Supplies a fresh ID, given a test for IDs in use; the draft rejects one already in use. */
  readonly createId: (inUse: (id: Id) => boolean) => Id;
  /** Sorted constraints to resolve node placements through. */
  readonly constraints: readonly Constraint[];
  readonly geometry: GeometryRegistry;
  readonly geometryLimits: GeometryLimits;
  readonly projectionKinds: ProjectionKindRegistry;
}

/** The scene after applying commands, before the revision is advanced. */
export interface ApplyOutcome {
  readonly nodes: SceneState['nodes'];
  readonly surfaces: SceneState['surfaces'];
  readonly cameras: SceneState['cameras'];
  readonly viewports: SceneState['viewports'];
  readonly orbitRootId: Id | null;
  readonly rootIds: readonly Id[];
  readonly selection: readonly Id[];
  readonly focusedId: Id | null;
  readonly commandTypes: readonly OperationType[];
  /** Nodes created, changed or removed, in the order they were first touched. */
  readonly touched: readonly Id[];
  /** Surfaces created, changed or removed, in the order they were first touched. */
  readonly touchedSurfaces: readonly Id[];
  /** Cameras and viewports created, changed or removed: view state, not layout. */
  readonly touchedCameras: readonly Id[];
  readonly touchedViewports: readonly Id[];
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

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

class Draft {
  readonly #base: SceneState;
  readonly #ctx: ApplyContext;
  readonly #nodes: TableDraft<NodeRecord>;
  readonly #surfaces: TableDraft<SurfaceRecord>;
  readonly #cameras: TableDraft<CameraRecord>;
  readonly #viewports: TableDraft<ViewportRecord>;
  #orbitRootId: Id | null;
  #rootIds: readonly Id[];
  #selection: readonly Id[];
  #focusedId: Id | null;
  readonly #commandTypes: SceneCommandType[] = [];
  readonly #touched = new Set<Id>();
  readonly #touchedSurfaces = new Set<Id>();
  readonly #touchedCameras = new Set<Id>();
  readonly #touchedViewports = new Set<Id>();
  /** Nodes whose placement was proposed in this transaction: constraints resolve these. */
  readonly #placed = new Set<Id>();
  readonly #created: Id[] = [];

  constructor(base: SceneState, ctx: ApplyContext) {
    this.#base = base;
    this.#ctx = ctx;
    this.#nodes = base.nodes.edit();
    this.#surfaces = base.surfaces.edit();
    this.#cameras = base.cameras.edit();
    this.#viewports = base.viewports.edit();
    this.#orbitRootId = base.orbitRootId;
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
      case 'surface.attach':
        this.#attachSurface(command['surface'], `${path}.surface`);
        return;
      case 'surface.patch':
        this.#patchSurface(command, path);
        return;
      case 'surface.move':
        this.#moveSurface(command, path);
        return;
      case 'surface.reorder': {
        const surface = this.#requireSurface(command['id'], `${path}.id`);
        this.#insertSurface(surface.ownerNodeId, surface.id, command['index'], `${path}.index`);
        return;
      }
      case 'surface.rebind':
        this.#rebindSurface(command, path);
        return;
      case 'surface.detach': {
        const surface = this.#requireSurface(command['id'], `${path}.id`);
        this.#assertUnlocked(surface, 'surface', path, 'be detached');
        this.#setSurfaces(
          surface.ownerNodeId,
          this.#requireNode(surface.ownerNodeId, path).surfaceIds.filter((s) => s !== surface.id),
        );
        this.#removeSurface(surface.id);
        return;
      }
      case 'camera.create':
        this.#createCamera(command['camera'], `${path}.camera`);
        return;
      case 'camera.patch':
        this.#patchCamera(command, path);
        return;
      case 'camera.delete': {
        const camera = this.#requireCamera(command['id'], `${path}.id`);
        const user = [...this.#viewports.values()].find((v) => v.cameraId === camera.id);
        if (user !== undefined) {
          throw invalid(
            `${path}.id`,
            `names camera "${camera.id}", which viewport "${user.id}" uses`,
          );
        }
        this.#cameras.delete(camera.id);
        this.#touchedCameras.add(camera.id);
        return;
      }
      case 'viewport.create':
        this.#createViewport(command['viewport'], `${path}.viewport`);
        return;
      case 'viewport.patch':
        this.#patchViewport(command, path);
        return;
      case 'viewport.delete': {
        const viewport = this.#requireViewport(command['id'], `${path}.id`);
        this.#viewports.delete(viewport.id);
        this.#touchedViewports.add(viewport.id);
        return;
      }
      case 'orbitRoot.set': {
        const nodeId = expectIdOrNull(command['nodeId'], `${path}.nodeId`);
        if (nodeId !== null) {
          this.#requireNode(nodeId, `${path}.nodeId`);
        }
        this.#orbitRootId = nodeId;
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
      surfaces: this.#surfaces.freeze(),
      cameras: this.#cameras.freeze(),
      viewports: this.#viewports.freeze(),
      // A deleted orbit root leaves the workspace without one.
      orbitRootId:
        this.#orbitRootId !== null && this.#nodes.has(this.#orbitRootId) ? this.#orbitRootId : null,
      rootIds: this.#rootIds,
      selection:
        selection.length === this.#selection.length ? this.#selection : Object.freeze(selection),
      focusedId,
      commandTypes: Object.freeze([...this.#commandTypes]),
      touched: Object.freeze([...this.#touched]),
      touchedSurfaces: Object.freeze([...this.#touchedSurfaces]),
      touchedCameras: Object.freeze([...this.#touchedCameras]),
      touchedViewports: Object.freeze([...this.#touchedViewports]),
      createdIds: Object.freeze([...this.#created]),
    };
  }

  // --- camera and viewport commands -------------------------------------------------------

  #createCamera(raw: unknown, path: string): void {
    const spec = expectRecord(raw, path, CAMERA_SPEC_FIELDS);
    const id =
      spec['id'] === undefined
        ? this.#freshId(`${path}.id`)
        : this.#unusedId(spec['id'], `${path}.id`);
    const near = spec['near'] === undefined ? 0.05 : expectPositive(spec['near'], `${path}.near`);
    const far = spec['far'] === undefined ? null : this.#far(spec['far'], near, `${path}.far`);
    this.#putCamera({
      id,
      position:
        spec['position'] === undefined
          ? ZERO_POSITION
          : expectVec3(spec['position'], `${path}.position`),
      rotation:
        spec['rotation'] === undefined
          ? IDENTITY_QUAT
          : expectRotation(spec['rotation'], `${path}.rotation`),
      near,
      far,
      label: spec['label'] === undefined ? null : expectLabel(spec['label'], `${path}.label`),
      metadata:
        spec['metadata'] === undefined
          ? EMPTY_METADATA
          : copyMetadata(spec['metadata'], `${path}.metadata`),
      createdAt: this.#ctx.now,
      updatedAt: this.#ctx.now,
    });
    this.#created.push(id);
  }

  #patchCamera(command: Record<string, unknown>, path: string): void {
    const camera = this.#requireCamera(command['id'], `${path}.id`);
    const next: Mutable<CameraRecord> = { ...camera, updatedAt: this.#ctx.now };
    if (command['position'] !== undefined) {
      next.position = expectVec3(command['position'], `${path}.position`);
    }
    if (command['rotation'] !== undefined) {
      next.rotation = expectRotation(command['rotation'], `${path}.rotation`);
    }
    if (command['near'] !== undefined) {
      next.near = expectPositive(command['near'], `${path}.near`);
    }
    if (command['far'] !== undefined) {
      next.far = this.#far(command['far'], next.near, `${path}.far`);
    } else if (next.far !== null && next.far <= next.near) {
      throw invalid(
        `${path}.near`,
        `must be less than the camera's far distance ${String(next.far)}`,
      );
    }
    if (command['label'] !== undefined) {
      next.label = expectLabel(command['label'], `${path}.label`);
    }
    if (command['metadata'] !== undefined) {
      next.metadata = patchMetadata(camera.metadata, command['metadata'], `${path}.metadata`);
    }
    this.#putCamera(next);
  }

  #far(raw: unknown, near: number, path: string): number | null {
    if (raw === null) {
      return null;
    }
    const far = expectPositive(raw, path);
    if (far <= near) {
      throw invalid(path, `must be greater than the near distance ${String(near)}`);
    }
    return far;
  }

  #createViewport(raw: unknown, path: string): void {
    const spec = expectRecord(raw, path, VIEWPORT_SPEC_FIELDS);
    const id =
      spec['id'] === undefined
        ? this.#freshId(`${path}.id`)
        : this.#unusedId(spec['id'], `${path}.id`);
    this.#putViewport({
      id,
      cameraId: this.#requireCamera(spec['cameraId'], `${path}.cameraId`).id,
      projection: this.#projection(spec['projection'], `${path}.projection`),
      mode: spec['mode'] === undefined ? 'panorama' : expectNonBlank(spec['mode'], `${path}.mode`),
      size: viewportSize(spec['size'], `${path}.size`),
      navigation:
        spec['navigation'] === undefined
          ? 'camera'
          : navigationTarget(spec['navigation'], `${path}.navigation`),
      renderer: optionalVersionedId(spec['renderer'], `${path}.renderer`),
      compositor: optionalVersionedId(spec['compositor'], `${path}.compositor`),
      label: spec['label'] === undefined ? null : expectLabel(spec['label'], `${path}.label`),
      metadata:
        spec['metadata'] === undefined
          ? EMPTY_METADATA
          : copyMetadata(spec['metadata'], `${path}.metadata`),
      createdAt: this.#ctx.now,
      updatedAt: this.#ctx.now,
    });
    this.#created.push(id);
  }

  #patchViewport(command: Record<string, unknown>, path: string): void {
    const viewport = this.#requireViewport(command['id'], `${path}.id`);
    const next: Mutable<ViewportRecord> = { ...viewport, updatedAt: this.#ctx.now };
    if (command['cameraId'] !== undefined) {
      next.cameraId = this.#requireCamera(command['cameraId'], `${path}.cameraId`).id;
    }
    if (command['projection'] !== undefined) {
      next.projection = this.#projection(command['projection'], `${path}.projection`);
    }
    if (command['mode'] !== undefined) {
      next.mode = expectNonBlank(command['mode'], `${path}.mode`);
    }
    if (command['size'] !== undefined) {
      next.size = viewportSize(command['size'], `${path}.size`);
    }
    if (command['navigation'] !== undefined) {
      next.navigation = navigationTarget(command['navigation'], `${path}.navigation`);
    }
    if (command['renderer'] !== undefined) {
      next.renderer = optionalVersionedId(command['renderer'], `${path}.renderer`);
    }
    if (command['compositor'] !== undefined) {
      next.compositor = optionalVersionedId(command['compositor'], `${path}.compositor`);
    }
    if (command['label'] !== undefined) {
      next.label = expectLabel(command['label'], `${path}.label`);
    }
    if (command['metadata'] !== undefined) {
      next.metadata = patchMetadata(viewport.metadata, command['metadata'], `${path}.metadata`);
    }
    this.#putViewport(next);
  }

  /** A registered projection kind and a configuration it accepts. */
  #projection(raw: unknown, path: string): ProjectionSetting {
    const record = expectRecord(raw, path, ['id', 'config']);
    const id = expectVersionedId(record['id'], `${path}.id`);
    const kind = this.#ctx.projectionKinds.get(id);
    if (kind === undefined) {
      throw invalid(`${path}.id`, `names projection "${id}", which is not registered`);
    }
    if (!Object.hasOwn(record, 'config')) {
      throw invalid(`${path}.config`, 'is required (null when the projection takes none)');
    }
    const config = copyJson(record['config'], `${path}.config`);
    const issue = projectionConfigIssue(kind, config);
    if (issue !== null) {
      throw invalid(`${path}.config`, `is invalid: ${issue}`);
    }
    return Object.freeze({ id, config });
  }

  #requireCamera(raw: unknown, path: string): CameraRecord {
    const id = expectId(raw, path);
    const camera = this.#cameras.get(id);
    if (camera === undefined) {
      throw new RejectionSignal('UNKNOWN_ENTITY', `${path}: no camera "${id}" in this workspace`, {
        path,
        entityId: id,
      });
    }
    return camera;
  }

  #requireViewport(raw: unknown, path: string): ViewportRecord {
    const id = expectId(raw, path);
    const viewport = this.#viewports.get(id);
    if (viewport === undefined) {
      throw new RejectionSignal(
        'UNKNOWN_ENTITY',
        `${path}: no viewport "${id}" in this workspace`,
        {
          path,
          entityId: id,
        },
      );
    }
    return viewport;
  }

  #putCamera(record: CameraRecord): void {
    this.#cameras.set(record.id, Object.freeze(record));
    this.#touchedCameras.add(record.id);
  }

  #putViewport(record: ViewportRecord): void {
    this.#viewports.set(record.id, Object.freeze(record));
    this.#touchedViewports.add(record.id);
  }

  // --- node commands ----------------------------------------------------------------------

  #create(raw: unknown, path: string): void {
    const spec = expectRecord(raw, path, NODE_SPEC_FIELDS);
    const id =
      spec['id'] === undefined
        ? this.#freshId(`${path}.id`)
        : this.#unusedId(spec['id'], `${path}.id`);
    const parentId =
      spec['parentId'] === undefined ? null : expectIdOrNull(spec['parentId'], `${path}.parentId`);
    if (parentId !== null) {
      this.#requireNode(parentId, `${path}.parentId`);
    }
    this.#putNode({
      id,
      kind: expectNonBlank(spec['kind'], `${path}.kind`),
      parentId,
      childIds: EMPTY,
      surfaceIds: EMPTY,
      transform:
        spec['transform'] === undefined
          ? IDENTITY_TRANSFORM
          : expectTransform(spec['transform'], `${path}.transform`),
      bounds: expectBounds(spec['bounds'], `${path}.bounds`),
      flags: flagsFrom(spec['flags'], `${path}.flags`),
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
    const node = this.#requireNode(command['id'], `${path}.id`);
    const next: Mutable<NodeRecord> = { ...node, updatedAt: this.#ctx.now };
    if (command['transform'] !== undefined) {
      this.#assertUnlocked(node, 'node', path, 'move');
      next.transform = expectTransform(command['transform'], `${path}.transform`);
      this.#placed.add(node.id);
    }
    if (command['bounds'] !== undefined) {
      this.#assertUnlocked(node, 'node', path, 'resize');
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
    this.#putNode(next);
  }

  #reparent(command: Record<string, unknown>, path: string): void {
    const node = this.#requireNode(command['id'], `${path}.id`);
    const parentId = expectIdOrNull(command['parentId'], `${path}.parentId`);
    if (parentId !== null) {
      this.#requireNode(parentId, `${path}.parentId`);
      if (!models.mayParent(node.id, this.#chain(parentId))) {
        throw invalid(`${path}.parentId`, `would make "${node.id}" its own ancestor`);
      }
    }
    this.#assertUnlocked(node, 'node', path, 'be reparented');
    const keep = this.#keepMode(command['keep'], `${path}.keep`);
    this.#moveTo(node.id, parentId, keep, command['index'], `${path}.index`, path);
  }

  #reorder(command: Record<string, unknown>, path: string): void {
    const node = this.#requireNode(command['id'], `${path}.id`);
    this.#insertChild(node.parentId, node.id, command['index'], `${path}.index`);
  }

  #duplicate(command: Record<string, unknown>, path: string): void {
    const source = this.#requireNode(command['id'], `${path}.id`);
    if (effectiveState(this.#nodes, source.id)?.active !== true) {
      throw invalid(`${path}.id`, `names archived node "${source.id}", which cannot be duplicated`);
    }
    const subtree = [source.id, ...this.#activeDescendants(source.id)];
    const surfaceIds = subtree.flatMap((id) => this.#requireNode(id, path).surfaceIds);
    const chosen =
      command['ids'] === undefined
        ? {}
        : expectRecord(command['ids'], `${path}.ids`, [...subtree, ...surfaceIds]);
    const reuseKeys = command['reuseBindingKeys'] ?? false;
    if (typeof reuseKeys !== 'boolean') {
      throw invalid(`${path}.reuseBindingKeys`, `must be a boolean (got ${describe(reuseKeys)})`);
    }
    const mapping = new Map<Id, Id>();
    const used = new Set<Id>();
    for (const id of [...subtree, ...surfaceIds]) {
      const wanted = chosen[id];
      const copyId =
        wanted === undefined
          ? this.#freshId(`${path}.ids`, used)
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
      this.#requireNode(parentId, `${path}.parentId`);
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
      const original = this.#requireNode(id, `${path}.id`);
      const isRoot = id === source.id;
      this.#putNode({
        ...original,
        id: mapped(id),
        parentId: isRoot ? parentId : mapped(original.parentId ?? ''),
        childIds: Object.freeze(original.childIds.filter((c) => mapping.has(c)).map(mapped)),
        surfaceIds: Object.freeze(original.surfaceIds.map(mapped)),
        transform: isRoot ? rootTransform : original.transform,
        status: 'active',
        createdAt: this.#ctx.now,
        updatedAt: this.#ctx.now,
      });
      this.#created.push(mapped(id));
      this.#placed.add(mapped(id));
      for (const surfaceId of original.surfaceIds) {
        const surface = this.#requireSurface(surfaceId, path);
        this.#putSurface({
          ...surface,
          id: mapped(surfaceId),
          ownerNodeId: mapped(id),
          bindingKey: reuseKeys ? surface.bindingKey : null,
          createdAt: this.#ctx.now,
          updatedAt: this.#ctx.now,
        });
        this.#created.push(mapped(surfaceId));
      }
    }
    this.#insertChild(parentId, mapped(source.id), undefined, `${path}.parentId`);
  }

  #setStatus(command: Record<string, unknown>, path: string, status: NodeRecord['status']): void {
    const node = this.#requireNode(command['id'], `${path}.id`);
    if (node.status === status) {
      throw invalid(`${path}.id`, `names node "${node.id}", which is already ${status}`);
    }
    this.#assertUnlocked(node, 'node', path, status === 'archived' ? 'be archived' : 'be restored');
    this.#putNode({ ...node, status, updatedAt: this.#ctx.now });
  }

  #delete(command: Record<string, unknown>, path: string): void {
    const node = this.#requireNode(command['id'], `${path}.id`);
    const mode: unknown = command['mode'];
    if (mode !== 'subtree' && mode !== 'detachChildren' && mode !== 'rejectIfChildren') {
      throw invalid(
        `${path}.mode`,
        `must be "subtree", "detachChildren" or "rejectIfChildren" (got ${describe(mode)})`,
      );
    }
    this.#assertUnlocked(node, 'node', path, 'be deleted');
    if (mode === 'rejectIfChildren' && node.childIds.length > 0) {
      throw invalid(
        `${path}.id`,
        `names node "${node.id}", which still has ${node.childIds.length} children`,
      );
    }
    if (mode === 'subtree') {
      const descendants = descendantIds(this.#nodes, node.id);
      for (const id of descendants) {
        this.#assertUnlocked(this.#requireNode(id, path), 'node', path, 'be deleted');
      }
      for (const id of descendants) {
        this.#removeNode(id);
      }
    } else {
      this.#dissolve(node.id, path);
    }
    this.#detachFromParent(node.id);
    this.#removeNode(node.id);
  }

  #group(command: Record<string, unknown>, path: string): void {
    const memberIds = expectIdList(command['nodeIds'], `${path}.nodeIds`);
    if (memberIds.length === 0) {
      throw invalid(`${path}.nodeIds`, 'must list at least one node');
    }
    const members = memberIds.map((id, i) => {
      const member = this.#requireNode(id, `${path}.nodeIds[${i}]`);
      this.#assertUnlocked(member, 'node', `${path}.nodeIds[${i}]`, 'be grouped');
      return member;
    });
    const nested = models.nestedMember(members.map((m) => [m.id, this.#chain(m.id)]));
    if (nested !== null) {
      const [i, j] = nested;
      throw invalid(
        `${path}.nodeIds[${String(i)}]`,
        `names "${String(members[Number(i)]?.id)}", which is inside member "${String(members[Number(j)]?.id)}"`,
      );
    }
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
    this.#putNode({
      id: groupId,
      kind:
        spec['kind'] === undefined ? 'group' : expectNonBlank(spec['kind'], `${path}.group.kind`),
      parentId,
      childIds: EMPTY,
      surfaceIds: EMPTY,
      transform,
      bounds,
      flags: DEFAULT_FLAGS,
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
    const node = this.#requireNode(command['id'], `${path}.id`);
    this.#assertUnlocked(node, 'node', path, 'be ungrouped');
    this.#dissolve(node.id, path);
    this.#detachFromParent(node.id);
    this.#removeNode(node.id);
  }

  // --- surface commands -------------------------------------------------------------------

  #attachSurface(raw: unknown, path: string): void {
    const spec = expectRecord(raw, path, SURFACE_SPEC_FIELDS);
    const id =
      spec['id'] === undefined
        ? this.#freshId(`${path}.id`)
        : this.#unusedId(spec['id'], `${path}.id`);
    const owner = this.#requireNode(spec['ownerNodeId'], `${path}.ownerNodeId`);
    const bounds = expectBounds(spec['bounds'], `${path}.bounds`);
    this.#putSurface({
      id,
      ownerNodeId: owner.id,
      bindingKey: expectBindingKey(spec['bindingKey'], `${path}.bindingKey`),
      adapterTypeId: expectVersionedId(spec['adapterTypeId'], `${path}.adapterTypeId`),
      transform:
        spec['transform'] === undefined
          ? IDENTITY_TRANSFORM
          : expectTransform(spec['transform'], `${path}.transform`),
      bounds,
      geometry:
        spec['geometry'] === undefined
          ? RECT_GEOMETRY
          : this.#geometry(spec['geometry'], bounds, `${path}.geometry`),
      interaction:
        spec['interaction'] === undefined
          ? 'content'
          : expectInteraction(spec['interaction'], `${path}.interaction`),
      flags: flagsFrom(spec['flags'], `${path}.flags`),
      label: spec['label'] === undefined ? null : expectLabel(spec['label'], `${path}.label`),
      metadata:
        spec['metadata'] === undefined
          ? EMPTY_METADATA
          : copyMetadata(spec['metadata'], `${path}.metadata`),
      createdAt: this.#ctx.now,
      updatedAt: this.#ctx.now,
    });
    this.#insertSurface(owner.id, id, spec['index'], `${path}.index`);
    this.#created.push(id);
  }

  #patchSurface(command: Record<string, unknown>, path: string): void {
    const surface = this.#requireSurface(command['id'], `${path}.id`);
    const next: Mutable<SurfaceRecord> = { ...surface, updatedAt: this.#ctx.now };
    if (command['transform'] !== undefined) {
      this.#assertUnlocked(surface, 'surface', path, 'move');
      next.transform = expectTransform(command['transform'], `${path}.transform`);
    }
    if (command['bounds'] !== undefined) {
      this.#assertUnlocked(surface, 'surface', path, 'resize');
      next.bounds = expectBounds(command['bounds'], `${path}.bounds`);
    }
    if (command['geometry'] !== undefined) {
      next.geometry = this.#geometry(command['geometry'], next.bounds, `${path}.geometry`);
    } else if (command['bounds'] !== undefined) {
      this.#refit(surface, next.bounds, `${path}.bounds`);
    }
    if (command['interaction'] !== undefined) {
      next.interaction = expectInteraction(command['interaction'], `${path}.interaction`);
    }
    if (command['flags'] !== undefined) {
      next.flags = Object.freeze({
        ...surface.flags,
        ...expectFlags(command['flags'], `${path}.flags`),
      });
    }
    if (command['label'] !== undefined) {
      next.label = expectLabel(command['label'], `${path}.label`);
    }
    if (command['metadata'] !== undefined) {
      next.metadata = patchMetadata(surface.metadata, command['metadata'], `${path}.metadata`);
    }
    this.#putSurface(next);
  }

  #moveSurface(command: Record<string, unknown>, path: string): void {
    const surface = this.#requireSurface(command['id'], `${path}.id`);
    const owner = this.#requireNode(command['ownerNodeId'], `${path}.ownerNodeId`);
    this.#assertUnlocked(surface, 'surface', path, 'move');
    const keep = this.#keepMode(command['keep'], `${path}.keep`);
    let transform = surface.transform;
    if (keep === 'world' && owner.id !== surface.ownerNodeId) {
      const world = mat4Multiply(
        this.#worldOf(surface.ownerNodeId, path),
        mat4FromTransform(surface.transform),
      );
      const inverse = mat4InvertAffine(this.#worldOf(owner.id, path));
      const local = inverse === null ? null : mat4Decompose(mat4Multiply(inverse, world));
      if (!local?.ok) {
        const why = local === null ? 'is singular' : `has ${local.reason}`;
        throw invalid(
          path,
          `cannot keep the world placement of surface "${surface.id}" on "${owner.id}": the result ${why}`,
        );
      }
      transform = freezeTransform(local.transform);
    }
    this.#setSurfaces(
      surface.ownerNodeId,
      this.#requireNode(surface.ownerNodeId, path).surfaceIds.filter((s) => s !== surface.id),
    );
    this.#putSurface({ ...surface, ownerNodeId: owner.id, transform, updatedAt: this.#ctx.now });
    this.#insertSurface(owner.id, surface.id, command['index'], `${path}.index`);
  }

  #rebindSurface(command: Record<string, unknown>, path: string): void {
    const surface = this.#requireSurface(command['id'], `${path}.id`);
    if (!Object.hasOwn(command, 'bindingKey')) {
      throw invalid(`${path}.bindingKey`, 'is required (a key, or null for none)');
    }
    this.#putSurface({
      ...surface,
      bindingKey: expectBindingKey(command['bindingKey'], `${path}.bindingKey`),
      adapterTypeId:
        command['adapterTypeId'] === undefined
          ? surface.adapterTypeId
          : expectVersionedId(command['adapterTypeId'], `${path}.adapterTypeId`),
      updatedAt: this.#ctx.now,
    });
  }

  /**
   * A validated, frozen geometry descriptor. The kind must be registered; its params must be JSON
   * within the `maxParamsBytes` limit and valid for the provider and the surface's bounds.
   */
  #geometry(raw: unknown, bounds: Vec3, path: string): GeometryDescriptor {
    const record = expectRecord(raw, path, ['kind', 'params']);
    const kind = expectNonBlank(record['kind'], `${path}.kind`);
    const provider = this.#ctx.geometry.get(kind);
    if (provider === undefined) {
      throw invalid(`${path}.kind`, `names geometry kind "${kind}", which is not registered`);
    }
    if (!Object.hasOwn(record, 'params')) {
      throw invalid(`${path}.params`, 'is required (null when the kind takes none)');
    }
    const params = copyJson(record['params'], `${path}.params`);
    const issue = geometryParamsIssue(provider, params, bounds, this.#ctx.geometryLimits);
    if (issue !== null) {
      throw invalid(`${path}.params`, `is invalid: ${issue}`);
    }
    return Object.freeze({ kind, params });
  }

  /**
   * Checks that the surface's geometry fits new bounds; `path` names the bounds. A geometry whose
   * kind is no longer registered cannot be checked, so the bounds are refused: a command that
   * resizes such a surface must give a new geometry with them.
   */
  #refit(surface: SurfaceRecord, bounds: Vec3, path: string): void {
    const { kind, params } = surface.geometry;
    const provider = this.#ctx.geometry.get(kind);
    if (provider === undefined) {
      throw invalid(
        path,
        `cannot change: surface "${surface.id}" has geometry kind "${kind}", which is not registered, so its geometry cannot be checked against new bounds (give a new geometry with them)`,
      );
    }
    const issue = geometryParamsIssue(provider, params, bounds, this.#ctx.geometryLimits);
    if (issue !== null) {
      throw invalid(path, `does not fit the surface's ${kind} geometry: ${issue}`);
    }
  }

  // --- helpers ----------------------------------------------------------------------------

  #keepMode(raw: unknown, path: string): KeepMode {
    const keep: unknown = raw ?? (this.#ctx.source === 'user' ? 'world' : 'local');
    if (keep !== 'world' && keep !== 'local') {
      throw invalid(path, `must be "world" or "local" (got ${describe(keep)})`);
    }
    return keep;
  }

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
      this.#requireNode(parentId, path);
      const inside = models.memberInChain(
        members.map((m) => m.id),
        this.#chain(parentId),
      );
      if (inside !== null) {
        throw invalid(path, `is inside member "${String(members[Number(inside)]?.id)}"`);
      }
    }
    return parentId;
  }

  /** Moves the node's children to its parent at its position, keeping their world placement. */
  #dissolve(id: Id, path: string): void {
    const node = this.#requireNode(id, path);
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
    const node = this.#requireNode(id, path);
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
    this.#putNode({ ...node, parentId, transform, updatedAt: this.#ctx.now });
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
      throw this.#unknown(id, path, 'node');
    }
    return m;
  }

  #parentWorld(parentId: Id | null, path: string): Mat4 {
    const m = parentWorldMatrix(this.#nodes, parentId);
    if (m === undefined) {
      throw this.#unknown(parentId ?? '', path, 'node');
    }
    return m;
  }

  /** The node, then its ancestors, nearest first. */
  #chain(id: Id): Id[] {
    return [id, ...ancestorIds(this.#nodes, id)];
  }

  #assertSelectable(id: Id, path: string): void {
    this.#requireNode(id, path);
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
   * Resolves every proposed node placement through the constraints, ancestors before descendants
   * so a child is checked against its parent's final placement. Surfaces are placed relative to
   * their owners and are not constrained themselves.
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
      const node = this.#requireNode(id, `nodes.${id}`);
      const applicable: Constraint[] = [];
      for (const constraint of constraints) {
        const governs = constraintApplies(constraint, node);
        if (!governs.ok) {
          throw this.#defective(constraint.id, id, governs.reason);
        }
        if (governs.applies) {
          applicable.push(constraint);
        }
      }
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
        throw this.#defective(result.constraintId, id, result.reason);
      }
      if (result.transform !== node.transform) {
        this.#putNode({ ...node, transform: freezeTransform(result.transform) });
      }
    }
  }

  /** The rejection of node `id`'s placement by constraint `constraintId`, saying why. */
  #defective(constraintId: string, id: Id, reason: string): RejectionSignal {
    return new RejectionSignal(
      'CONSTRAINT_REJECTED',
      `constraint "${constraintId}" rejected the placement of "${id}": ${reason}`,
      { entityId: id, details: { constraintId } },
    );
  }

  #assertUnlocked(
    entity: NodeRecord | SurfaceRecord,
    what: 'node' | 'surface',
    path: string,
    action: string,
  ): void {
    if (models.lockRefuses(this.#ctx.source === 'user', entity.flags.locked)) {
      throw new RejectionSignal(
        'LOCKED',
        `${path}: ${what} "${entity.id}" is locked, so it cannot ${action}`,
        { path, entityId: entity.id },
      );
    }
  }

  #requireNode(raw: unknown, path: string): NodeRecord {
    const id = expectId(raw, path);
    const node = this.#nodes.get(id);
    if (node === undefined) {
      throw this.#unknown(id, path, 'node');
    }
    return node;
  }

  #requireSurface(raw: unknown, path: string): SurfaceRecord {
    const id = expectId(raw, path);
    const surface = this.#surfaces.get(id);
    if (surface === undefined) {
      throw this.#unknown(id, path, 'surface');
    }
    return surface;
  }

  #unknown(id: Id, path: string, what: 'node' | 'surface'): RejectionSignal {
    return new RejectionSignal('UNKNOWN_ENTITY', `${path}: no ${what} "${id}" in this workspace`, {
      path,
      entityId: id,
    });
  }

  #inUse(id: Id): boolean {
    return (
      this.#nodes.has(id) ||
      this.#surfaces.has(id) ||
      this.#cameras.has(id) ||
      this.#viewports.has(id)
    );
  }

  #unusedId(raw: unknown, path: string): Id {
    const id = expectId(raw, path);
    if (this.#inUse(id)) {
      throw invalid(path, `"${id}" is already in use in this workspace`);
    }
    return id;
  }

  /**
   * A generated ID, also avoiding `reserved` (IDs chosen but not yet written). A `createId` that
   * throws rejects the transaction at the generated ID's path, naming it.
   */
  #freshId(path: string, reserved: ReadonlySet<Id> = NO_IDS): Id {
    let id: unknown;
    try {
      id = this.#ctx.createId((candidate) => this.#inUse(candidate) || reserved.has(candidate));
    } catch (error) {
      throw invalid(
        `${path} (generated)`,
        `could not be made: createId threw: ${thrownText(error)}`,
      );
    }
    const fresh = expectId(id, `${path} (generated)`);
    if (reserved.has(fresh)) {
      throw invalid(`${path} (generated)`, `"${fresh}" is already in use in this workspace`);
    }
    return this.#unusedId(fresh, `${path} (generated)`);
  }

  #children(parentId: Id | null): Id[] {
    return [
      ...(parentId === null ? this.#rootIds : this.#requireNode(parentId, 'parent').childIds),
    ];
  }

  #setChildren(parentId: Id | null, childIds: readonly Id[]): void {
    const frozen = Object.freeze([...childIds]);
    if (parentId === null) {
      this.#rootIds = frozen;
    } else {
      this.#putNode({
        ...this.#requireNode(parentId, 'parent'),
        childIds: frozen,
        updatedAt: this.#ctx.now,
      });
    }
  }

  #detachFromParent(id: Id): void {
    const parentId = this.#requireNode(id, 'node').parentId;
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

  #setSurfaces(ownerId: Id, surfaceIds: readonly Id[]): void {
    this.#putNode({
      ...this.#requireNode(ownerId, 'owner'),
      surfaceIds: Object.freeze([...surfaceIds]),
      updatedAt: this.#ctx.now,
    });
  }

  /** Places surface `id` among `ownerId`'s surfaces at `rawIndex` (omitted: last). */
  #insertSurface(ownerId: Id, id: Id, rawIndex: unknown, path: string): void {
    const slots = this.#requireNode(ownerId, path).surfaceIds.filter((s) => s !== id);
    const index = rawIndex === undefined ? slots.length : expectIndex(rawIndex, path, slots.length);
    slots.splice(index, 0, id);
    this.#setSurfaces(ownerId, slots);
  }

  #putNode(record: NodeRecord): void {
    this.#nodes.set(record.id, Object.freeze(record));
    this.#touched.add(record.id);
  }

  /** Removes a node and its surface associations. */
  #removeNode(id: Id): void {
    for (const surfaceId of this.#nodes.get(id)?.surfaceIds ?? []) {
      this.#removeSurface(surfaceId);
    }
    this.#nodes.delete(id);
    this.#touched.add(id);
    this.#placed.delete(id);
  }

  #putSurface(record: SurfaceRecord): void {
    this.#surfaces.set(record.id, Object.freeze(record));
    this.#touchedSurfaces.add(record.id);
  }

  #removeSurface(id: Id): void {
    this.#surfaces.delete(id);
    this.#touchedSurfaces.add(id);
  }
}

function viewportSize(raw: unknown, path: string): ViewportRecord['size'] {
  const size = expectRecord(raw, path, ['width', 'height', 'devicePixelRatio']);
  return Object.freeze({
    width: expectPositive(size['width'], `${path}.width`),
    height: expectPositive(size['height'], `${path}.height`),
    devicePixelRatio: expectPositive(size['devicePixelRatio'], `${path}.devicePixelRatio`),
  });
}

function navigationTarget(raw: unknown, path: string): NavigationTarget {
  if (raw !== 'camera' && raw !== 'orbit') {
    throw invalid(path, `must be "camera" or "orbit" (got ${describe(raw)})`);
  }
  return raw;
}

function optionalVersionedId(raw: unknown, path: string): string | null {
  return raw === undefined || raw === null ? null : expectVersionedId(raw, path);
}

function flagsFrom(raw: unknown, path: string) {
  return raw === undefined
    ? DEFAULT_FLAGS
    : Object.freeze({ ...DEFAULT_FLAGS, ...expectFlags(raw, path) });
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
const NO_IDS: ReadonlySet<Id> = new Set();

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

const ZERO_POSITION: Vec3 = Object.freeze([0, 0, 0] as const);

const CAMERA_SPEC_FIELDS = [
  'id',
  'position',
  'rotation',
  'near',
  'far',
  'label',
  'metadata',
] as const;

const VIEWPORT_SPEC_FIELDS = [
  'id',
  'cameraId',
  'projection',
  'mode',
  'size',
  'navigation',
  'renderer',
  'compositor',
  'label',
  'metadata',
] as const;

const SURFACE_SPEC_FIELDS = [
  'id',
  'ownerNodeId',
  'bindingKey',
  'adapterTypeId',
  'index',
  'transform',
  'bounds',
  'geometry',
  'interaction',
  'flags',
  'label',
  'metadata',
] as const;

const GROUP_FIELDS = ['id', 'kind', 'label', 'parentId', 'transform', 'bounds'] as const;

const COMMAND_FIELDS: Readonly<Record<SceneCommandType, readonly string[]>> = {
  'node.create': ['node'],
  'node.patch': ['id', 'transform', 'bounds', 'label', 'tags', 'flags', 'metadata'],
  'node.reparent': ['id', 'parentId', 'keep', 'index'],
  'node.reorder': ['id', 'index'],
  'node.duplicate': ['id', 'ids', 'parentId', 'transform', 'reuseBindingKeys'],
  'node.archive': ['id'],
  'node.restoreArchived': ['id'],
  'node.delete': ['id', 'mode'],
  'node.group': ['nodeIds', 'group'],
  'node.ungroup': ['id'],
  'selection.set': ['ids'],
  'focus.set': ['id'],
  'surface.attach': ['surface'],
  'surface.patch': [
    'id',
    'transform',
    'bounds',
    'geometry',
    'interaction',
    'flags',
    'label',
    'metadata',
  ],
  'surface.move': ['id', 'ownerNodeId', 'keep', 'index'],
  'surface.reorder': ['id', 'index'],
  'surface.rebind': ['id', 'bindingKey', 'adapterTypeId'],
  'surface.detach': ['id'],
  'camera.create': ['camera'],
  'camera.patch': ['id', 'position', 'rotation', 'near', 'far', 'label', 'metadata'],
  'camera.delete': ['id'],
  'viewport.create': ['viewport'],
  'viewport.patch': [
    'id',
    'cameraId',
    'projection',
    'mode',
    'size',
    'navigation',
    'renderer',
    'compositor',
    'label',
    'metadata',
  ],
  'viewport.delete': ['id'],
  'orbitRoot.set': ['nodeId'],
};
