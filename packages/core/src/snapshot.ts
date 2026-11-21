import type { Transform3D } from '@swf/math';
import { makeError, RejectionSignal, SwfFailure } from './errors.js';
import type { GeometryDescriptor } from './geometry.js';
import type { Metadata } from './json.js';
import { canonicalJson, copyJson, copyMetadata, describe } from './json.js';
import type {
  CameraRecord,
  EntityFlags,
  Id,
  NodeRecord,
  SceneState,
  SurfaceRecord,
  ViewportRecord,
} from './model.js';
import { FLAG_NAMES } from './model.js';
import {
  expectBindingKey,
  expectBounds,
  expectFlags,
  expectId,
  expectIdList,
  expectIdOrNull,
  expectInteraction,
  expectLabel,
  expectNonBlank,
  expectPositive,
  expectRotation,
  expectTags,
  expectTransform,
  expectVec3,
  expectVersionedId,
  invalid,
} from './validate.js';

/**
 * A workspace's committed scene as plain, canonical JSON data: every node, surface, camera and
 * viewport with all its fields, the hierarchy, the orbit root, the selection and focus. Entities
 * are ordered by ID, record fields in a fixed order and metadata keys sorted, so two snapshots of
 * the same scene are identical. It holds no runtime handle, element, callback or content: those
 * are never part of the scene.
 */
export interface SceneSnapshot {
  readonly workspaceId: Id;
  readonly revision: number;
  /** Root nodes in presentation order. */
  readonly rootIds: readonly Id[];
  readonly nodes: readonly NodeRecord[];
  readonly surfaces: readonly SurfaceRecord[];
  readonly cameras: readonly CameraRecord[];
  readonly viewports: readonly ViewportRecord[];
  readonly orbitRootId: Id | null;
  readonly selection: readonly Id[];
  readonly focusedId: Id | null;
}

/** The fields of a scene snapshot, in canonical order. */
export const SCENE_SNAPSHOT_FIELDS = Object.freeze([
  'workspaceId',
  'revision',
  'rootIds',
  'nodes',
  'surfaces',
  'cameras',
  'viewports',
  'orbitRootId',
  'selection',
  'focusedId',
] as const);

const NODE_FIELDS = [
  'id',
  'kind',
  'parentId',
  'childIds',
  'surfaceIds',
  'transform',
  'bounds',
  'flags',
  'label',
  'tags',
  'metadata',
  'status',
  'createdAt',
  'updatedAt',
] as const;

const SURFACE_FIELDS = [
  'id',
  'ownerNodeId',
  'bindingKey',
  'adapterTypeId',
  'transform',
  'bounds',
  'geometry',
  'interaction',
  'flags',
  'label',
  'metadata',
  'createdAt',
  'updatedAt',
] as const;

const CAMERA_FIELDS = [
  'id',
  'position',
  'rotation',
  'near',
  'far',
  'label',
  'metadata',
  'createdAt',
  'updatedAt',
] as const;

const VIEWPORT_FIELDS = [
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
  'createdAt',
  'updatedAt',
] as const;

const byId = <T extends { readonly id: Id }>(a: T, b: T) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The canonical snapshot of a scene state. */
export function serializeScene(state: SceneState): SceneSnapshot {
  return deepFreeze({
    workspaceId: state.workspaceId,
    revision: state.revision,
    rootIds: [...state.rootIds],
    nodes: [...state.nodes.values()].sort(byId).map(nodeSnapshot),
    surfaces: [...state.surfaces.values()].sort(byId).map(surfaceSnapshot),
    cameras: [...state.cameras.values()].sort(byId).map(cameraSnapshot),
    viewports: [...state.viewports.values()].sort(byId).map(viewportSnapshot),
    orbitRootId: state.orbitRootId,
    selection: [...state.selection],
    focusedId: state.focusedId,
  });
}

/**
 * Checks that `value` is a scene snapshot whose references all hold, and returns its canonical,
 * frozen copy. Entities may come in any order; everything else must be exactly as a workspace
 * produces it. Throws {@link SwfFailure} (`SNAPSHOT_INVALID`) naming the first failing path, such
 * as `nodes[2].transform.rotation`: a malformed or non-finite field, an unknown field, a duplicate
 * ID, a missing or inconsistent reference, or a cycle in the hierarchy. Geometry and projection
 * settings are checked for shape here and against the registered kinds when a scene is restored.
 */
export function validateSceneSnapshot(value: unknown): SceneSnapshot {
  try {
    return checkScene(value);
  } catch (error) {
    if (error instanceof RejectionSignal) {
      throw new SwfFailure(
        makeError('SNAPSHOT_INVALID', error.message, {
          ...(error.path === undefined ? {} : { path: error.path }),
        }),
      );
    }
    throw error;
  }
}

function nodeSnapshot(node: NodeRecord): NodeRecord {
  return {
    id: node.id,
    kind: node.kind,
    parentId: node.parentId,
    childIds: [...node.childIds],
    surfaceIds: [...node.surfaceIds],
    transform: transformSnapshot(node.transform),
    bounds: [...node.bounds],
    flags: flagsSnapshot(node.flags),
    label: node.label,
    tags: [...node.tags],
    metadata: metadataSnapshot(node.metadata),
    status: node.status,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function surfaceSnapshot(surface: SurfaceRecord): SurfaceRecord {
  return {
    id: surface.id,
    ownerNodeId: surface.ownerNodeId,
    bindingKey: surface.bindingKey,
    adapterTypeId: surface.adapterTypeId,
    transform: transformSnapshot(surface.transform),
    bounds: [...surface.bounds],
    geometry: { kind: surface.geometry.kind, params: canonicalJson(surface.geometry.params) },
    interaction: surface.interaction,
    flags: flagsSnapshot(surface.flags),
    label: surface.label,
    metadata: metadataSnapshot(surface.metadata),
    createdAt: surface.createdAt,
    updatedAt: surface.updatedAt,
  };
}

function cameraSnapshot(camera: CameraRecord): CameraRecord {
  return {
    id: camera.id,
    position: [...camera.position],
    rotation: [...camera.rotation],
    near: camera.near,
    far: camera.far,
    label: camera.label,
    metadata: metadataSnapshot(camera.metadata),
    createdAt: camera.createdAt,
    updatedAt: camera.updatedAt,
  };
}

function viewportSnapshot(viewport: ViewportRecord): ViewportRecord {
  return {
    id: viewport.id,
    cameraId: viewport.cameraId,
    projection: { id: viewport.projection.id, config: canonicalJson(viewport.projection.config) },
    mode: viewport.mode,
    size: {
      width: viewport.size.width,
      height: viewport.size.height,
      devicePixelRatio: viewport.size.devicePixelRatio,
    },
    navigation: viewport.navigation,
    renderer: viewport.renderer,
    compositor: viewport.compositor,
    label: viewport.label,
    metadata: metadataSnapshot(viewport.metadata),
    createdAt: viewport.createdAt,
    updatedAt: viewport.updatedAt,
  };
}

function transformSnapshot(t: Transform3D): Transform3D {
  return { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] };
}

function flagsSnapshot(flags: EntityFlags): EntityFlags {
  return Object.fromEntries(
    FLAG_NAMES.map((name) => [name, flags[name]]),
  ) as unknown as EntityFlags;
}

function metadataSnapshot(metadata: Metadata): Metadata {
  return canonicalJson(metadata) as Metadata;
}

// --- validation ----------------------------------------------------------------------------

function checkScene(value: unknown): SceneSnapshot {
  const record = expectFields(value, '', SCENE_SNAPSHOT_FIELDS);
  const workspaceId = expectId(record['workspaceId'], 'workspaceId');
  const revision = record['revision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw invalid('revision', `must be a whole number of at least 0 (got ${describe(revision)})`);
  }
  const nodes = expectArray(record['nodes'], 'nodes').map((n, i) => checkNode(n, `nodes[${i}]`));
  const surfaces = expectArray(record['surfaces'], 'surfaces').map((s, i) =>
    checkSurface(s, `surfaces[${i}]`),
  );
  const cameras = expectArray(record['cameras'], 'cameras').map((c, i) =>
    checkCamera(c, `cameras[${i}]`),
  );
  const viewports = expectArray(record['viewports'], 'viewports').map((v, i) =>
    checkViewport(v, `viewports[${i}]`),
  );
  const snapshot: SceneSnapshot = {
    workspaceId,
    revision,
    rootIds: expectIdList(record['rootIds'], 'rootIds'),
    nodes,
    surfaces,
    cameras,
    viewports,
    orbitRootId: expectIdOrNull(record['orbitRootId'], 'orbitRootId'),
    selection: expectIdList(record['selection'], 'selection'),
    focusedId: expectIdOrNull(record['focusedId'], 'focusedId'),
  };
  checkReferences(snapshot);
  return deepFreeze({
    ...snapshot,
    nodes: [...nodes].sort(byId),
    surfaces: [...surfaces].sort(byId),
    cameras: [...cameras].sort(byId),
    viewports: [...viewports].sort(byId),
  });
}

function checkNode(value: unknown, path: string): NodeRecord {
  const r = expectFields(value, path, NODE_FIELDS);
  const status = r['status'];
  if (status !== 'active' && status !== 'archived') {
    throw invalid(`${path}.status`, `must be "active" or "archived" (got ${describe(status)})`);
  }
  return {
    id: expectId(r['id'], `${path}.id`),
    kind: expectNonBlank(r['kind'], `${path}.kind`),
    parentId: expectIdOrNull(r['parentId'], `${path}.parentId`),
    childIds: expectIdList(r['childIds'], `${path}.childIds`),
    surfaceIds: expectIdList(r['surfaceIds'], `${path}.surfaceIds`),
    transform: expectTransform(r['transform'], `${path}.transform`),
    bounds: expectBounds(r['bounds'], `${path}.bounds`),
    flags: checkFlags(r['flags'], `${path}.flags`),
    label: expectLabel(r['label'], `${path}.label`),
    tags: expectTags(r['tags'], `${path}.tags`),
    metadata: metadataSnapshot(copyMetadata(r['metadata'], `${path}.metadata`)),
    status,
    createdAt: expectTime(r['createdAt'], `${path}.createdAt`),
    updatedAt: expectTime(r['updatedAt'], `${path}.updatedAt`),
  };
}

function checkSurface(value: unknown, path: string): SurfaceRecord {
  const r = expectFields(value, path, SURFACE_FIELDS);
  return {
    id: expectId(r['id'], `${path}.id`),
    ownerNodeId: expectId(r['ownerNodeId'], `${path}.ownerNodeId`),
    bindingKey: expectBindingKey(r['bindingKey'], `${path}.bindingKey`),
    adapterTypeId: expectVersionedId(r['adapterTypeId'], `${path}.adapterTypeId`),
    transform: expectTransform(r['transform'], `${path}.transform`),
    bounds: expectBounds(r['bounds'], `${path}.bounds`),
    geometry: checkGeometry(r['geometry'], `${path}.geometry`),
    interaction: expectInteraction(r['interaction'], `${path}.interaction`),
    flags: checkFlags(r['flags'], `${path}.flags`),
    label: expectLabel(r['label'], `${path}.label`),
    metadata: metadataSnapshot(copyMetadata(r['metadata'], `${path}.metadata`)),
    createdAt: expectTime(r['createdAt'], `${path}.createdAt`),
    updatedAt: expectTime(r['updatedAt'], `${path}.updatedAt`),
  };
}

function checkCamera(value: unknown, path: string): CameraRecord {
  const r = expectFields(value, path, CAMERA_FIELDS);
  const near = expectPositive(r['near'], `${path}.near`);
  const far = r['far'];
  if (far !== null && !(typeof far === 'number' && Number.isFinite(far) && far > near)) {
    throw invalid(`${path}.far`, `must be null or a finite number greater than near`);
  }
  return {
    id: expectId(r['id'], `${path}.id`),
    position: expectVec3(r['position'], `${path}.position`),
    rotation: expectRotation(r['rotation'], `${path}.rotation`),
    near,
    far,
    label: expectLabel(r['label'], `${path}.label`),
    metadata: metadataSnapshot(copyMetadata(r['metadata'], `${path}.metadata`)),
    createdAt: expectTime(r['createdAt'], `${path}.createdAt`),
    updatedAt: expectTime(r['updatedAt'], `${path}.updatedAt`),
  };
}

function checkViewport(value: unknown, path: string): ViewportRecord {
  const r = expectFields(value, path, VIEWPORT_FIELDS);
  const projection = expectFields(r['projection'], `${path}.projection`, ['id', 'config']);
  const size = expectFields(r['size'], `${path}.size`, ['width', 'height', 'devicePixelRatio']);
  const navigation = r['navigation'];
  if (navigation !== 'camera' && navigation !== 'orbit') {
    throw invalid(
      `${path}.navigation`,
      `must be "camera" or "orbit" (got ${describe(navigation)})`,
    );
  }
  const preference = (key: 'renderer' | 'compositor') =>
    r[key] === null ? null : expectVersionedId(r[key], `${path}.${key}`);
  return {
    id: expectId(r['id'], `${path}.id`),
    cameraId: expectId(r['cameraId'], `${path}.cameraId`),
    projection: {
      id: expectVersionedId(projection['id'], `${path}.projection.id`),
      config: canonicalJson(copyJson(projection['config'], `${path}.projection.config`)),
    },
    mode: expectNonBlank(r['mode'], `${path}.mode`),
    size: {
      width: expectPositive(size['width'], `${path}.size.width`),
      height: expectPositive(size['height'], `${path}.size.height`),
      devicePixelRatio: expectPositive(size['devicePixelRatio'], `${path}.size.devicePixelRatio`),
    },
    navigation,
    renderer: preference('renderer'),
    compositor: preference('compositor'),
    label: expectLabel(r['label'], `${path}.label`),
    metadata: metadataSnapshot(copyMetadata(r['metadata'], `${path}.metadata`)),
    createdAt: expectTime(r['createdAt'], `${path}.createdAt`),
    updatedAt: expectTime(r['updatedAt'], `${path}.updatedAt`),
  };
}

function checkGeometry(value: unknown, path: string): GeometryDescriptor {
  const r = expectFields(value, path, ['kind', 'params']);
  return {
    kind: expectNonBlank(r['kind'], `${path}.kind`),
    params: canonicalJson(copyJson(r['params'], `${path}.params`)),
  };
}

/** All eight flags, each present. */
function checkFlags(value: unknown, path: string): EntityFlags {
  const flags = expectFlags(value, path);
  const missing = FLAG_NAMES.find((name) => !(name in flags));
  if (missing !== undefined) {
    throw invalid(`${path}.${missing}`, 'is missing');
  }
  return flagsSnapshot(flags as EntityFlags);
}

function expectTime(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalid(path, `must be a finite time of at least 0 (got ${describe(value)})`);
  }
  return value;
}

function expectArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(path, `must be an array (got ${describe(value)})`);
  }
  return value;
}

/** A plain object with exactly `fields`: none missing, none unknown. */
function expectFields(
  value: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> {
  const at = (field: string) => (path === '' ? field : `${path}.${field}`);
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !isPlain(value)) {
    throw invalid(
      path === '' ? 'the snapshot' : path,
      `must be a plain object (got ${describe(value)})`,
    );
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !fields.includes(key));
  if (unknown !== undefined) {
    throw invalid(at(unknown), `is not a known field (expected one of ${fields.join(', ')})`);
  }
  const missing = fields.find((field) => !Object.hasOwn(record, field));
  if (missing !== undefined) {
    throw invalid(at(missing), 'is missing');
  }
  return record;
}

function isPlain(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Referential integrity: unique IDs, consistent hierarchy without cycles, existing targets. */
function checkReferences(s: SceneSnapshot): void {
  const kinds = new Map<Id, string>();
  const claim = (id: Id, kind: string, path: string) => {
    const taken = kinds.get(id);
    if (taken !== undefined) {
      throw invalid(path, `repeats the ID "${id}", already used by a ${taken}`);
    }
    kinds.set(id, kind);
  };
  s.nodes.forEach((n, i) => {
    claim(n.id, 'node', `nodes[${i}].id`);
  });
  s.surfaces.forEach((x, i) => {
    claim(x.id, 'surface', `surfaces[${i}].id`);
  });
  s.cameras.forEach((c, i) => {
    claim(c.id, 'camera', `cameras[${i}].id`);
  });
  s.viewports.forEach((v, i) => {
    claim(v.id, 'viewport', `viewports[${i}].id`);
  });
  const nodes = new Map(s.nodes.map((n) => [n.id, n]));
  const surfaces = new Map(s.surfaces.map((x) => [x.id, x]));
  const node = (id: Id, path: string): NodeRecord => {
    const found = nodes.get(id);
    if (found === undefined) {
      throw invalid(path, `refers to missing node "${id}"`);
    }
    return found;
  };
  s.nodes.forEach((n, i) => {
    const path = `nodes[${i}]`;
    if (n.parentId === null) {
      if (!s.rootIds.includes(n.id)) {
        throw invalid(`${path}.parentId`, `is null, but "${n.id}" is not in rootIds`);
      }
    } else if (!node(n.parentId, `${path}.parentId`).childIds.includes(n.id)) {
      throw invalid(`${path}.parentId`, `names "${n.parentId}", whose childIds lack "${n.id}"`);
    }
    n.childIds.forEach((child, j) => {
      if (node(child, `${path}.childIds[${j}]`).parentId !== n.id) {
        throw invalid(
          `${path}.childIds[${j}]`,
          `names "${child}", whose parentId is not "${n.id}"`,
        );
      }
    });
    n.surfaceIds.forEach((surfaceId, j) => {
      const surface = surfaces.get(surfaceId);
      if (surface === undefined) {
        throw invalid(`${path}.surfaceIds[${j}]`, `refers to missing surface "${surfaceId}"`);
      }
      if (surface.ownerNodeId !== n.id) {
        throw invalid(
          `${path}.surfaceIds[${j}]`,
          `names "${surfaceId}", whose owner is "${surface.ownerNodeId}"`,
        );
      }
    });
    // Following parents from any node must end at a root.
    const seen = new Set<Id>([n.id]);
    for (let at = n.parentId; at !== null; at = nodes.get(at)?.parentId ?? null) {
      if (seen.has(at)) {
        throw invalid(`${path}.parentId`, `puts "${n.id}" in a cycle of the hierarchy`);
      }
      seen.add(at);
    }
  });
  s.rootIds.forEach((id, i) => {
    if (node(id, `rootIds[${i}]`).parentId !== null) {
      throw invalid(`rootIds[${i}]`, `names "${id}", which has a parent`);
    }
  });
  s.surfaces.forEach((x, i) => {
    if (!node(x.ownerNodeId, `surfaces[${i}].ownerNodeId`).surfaceIds.includes(x.id)) {
      throw invalid(
        `surfaces[${i}].ownerNodeId`,
        `names "${x.ownerNodeId}", whose surfaceIds lack "${x.id}"`,
      );
    }
  });
  const cameras = new Set(s.cameras.map((c) => c.id));
  s.viewports.forEach((v, i) => {
    if (!cameras.has(v.cameraId)) {
      throw invalid(`viewports[${i}].cameraId`, `refers to missing camera "${v.cameraId}"`);
    }
  });
  if (s.orbitRootId !== null) {
    node(s.orbitRootId, 'orbitRootId');
  }
  s.selection.forEach((id, i) => {
    node(id, `selection[${i}]`);
  });
  if (s.focusedId !== null) {
    node(s.focusedId, 'focusedId');
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}
