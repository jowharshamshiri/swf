import type { Transform3D, Vec3 } from '@swf/math';
import { isFiniteVec3, isPositiveVec3, isUnitQuat, quatNormalize } from '@swf/math';
import { RejectionSignal } from './errors.js';
import { describe } from './json.js';
import type { EntityFlags, Id, InteractionRegion } from './model.js';
import { FLAG_NAMES } from './model.js';

/** An adapter type ID: a name and a positive integer version, such as `host.video/1`. */
export const ADAPTER_TYPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[1-9][0-9]*$/;

export function expectAdapterTypeId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ADAPTER_TYPE_ID.test(value)) {
    throw invalid(
      path,
      `must be an adapter type ID "<name>/<version>", such as "host.video/1" (got ${describe(value)})`,
    );
  }
  return value;
}

/** A binding key is opaque: any non-blank string, or null for none. It is never interpreted. */
export function expectBindingKey(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(path, `must be a non-blank string or null (got ${describe(value)})`);
  }
  return value;
}

export function expectInteraction(value: unknown, path: string): InteractionRegion {
  if (value !== 'content' && value !== 'none') {
    throw invalid(path, `must be "content" or "none" (got ${describe(value)})`);
  }
  return value;
}

/** Quaternions within this distance of unit length are accepted and stored normalized. */
export const QUAT_TOLERANCE = 1e-6;

export function invalid(path: string, message: string): RejectionSignal {
  return new RejectionSignal('INVALID_INPUT', `${path} ${message}`, { path });
}

/** A plain object whose keys are all in `allowed`; an unknown key is rejected by name. */
export function expectRecord(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(path, `must be an object (got ${describe(value)})`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalid(
        `${path}.${key}`,
        `is not a known field (expected one of ${allowed.join(', ')})`,
      );
    }
  }
  return value as Record<string, unknown>;
}

export function expectId(value: unknown, path: string): Id {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(path, `must be a non-blank string ID (got ${describe(value)})`);
  }
  return value;
}

export function expectIdOrNull(value: unknown, path: string): Id | null {
  return value === null ? null : expectId(value, path);
}

export function expectNonBlank(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(path, `must be a non-blank string (got ${describe(value)})`);
  }
  return value;
}

export function expectLabel(value: unknown, path: string): string | null {
  if (value !== null && typeof value !== 'string') {
    throw invalid(path, `must be a string or null (got ${describe(value)})`);
  }
  return value;
}

export function expectIndex(value: unknown, path: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw invalid(path, `must be an integer from 0 to ${max} (got ${String(value)})`);
  }
  return value;
}

function expectTuple(value: unknown, path: string, size: number): number[] {
  if (!Array.isArray(value) || value.length !== size) {
    throw invalid(path, `must be an array of ${size} numbers`);
  }
  return value.map((item: unknown, i) => {
    if (typeof item !== 'number') {
      throw invalid(`${path}[${i}]`, `must be a number (got ${describe(item)})`);
    }
    return item;
  });
}

export function expectVec3(value: unknown, path: string): Vec3 {
  const [x = NaN, y = NaN, z = NaN] = expectTuple(value, path, 3);
  const v: Vec3 = Object.freeze([x, y, z] as const);
  if (!isFiniteVec3(v)) {
    throw invalid(path, 'must contain finite numbers');
  }
  return v;
}

export function expectBounds(value: unknown, path: string): Vec3 {
  const v = expectVec3(value, path);
  if (!isPositiveVec3(v)) {
    throw invalid(path, 'must contain positive numbers');
  }
  return v;
}

/** A validated copy of a transform with its rotation renormalized. */
export function expectTransform(value: unknown, path: string): Transform3D {
  const record = expectRecord(value, path, ['position', 'rotation', 'scale']);
  const position = expectVec3(record['position'], `${path}.position`);
  const [x = NaN, y = NaN, z = NaN, w = NaN] = expectTuple(
    record['rotation'],
    `${path}.rotation`,
    4,
  );
  if (!isUnitQuat([x, y, z, w], QUAT_TOLERANCE)) {
    throw invalid(
      `${path}.rotation`,
      `must be a finite unit quaternion [x, y, z, w] (length within ${QUAT_TOLERANCE} of 1)`,
    );
  }
  const rotation = Object.freeze(quatNormalize([x, y, z, w]));
  const scale = expectVec3(record['scale'], `${path}.scale`);
  if (!isPositiveVec3(scale)) {
    throw invalid(`${path}.scale`, 'must contain positive numbers');
  }
  return Object.freeze({ position, rotation, scale });
}

export function expectFlags(value: unknown, path: string): Partial<EntityFlags> {
  const record = expectRecord(value, path, FLAG_NAMES);
  const out: Record<string, boolean | number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === 'presentationPriority') {
      if (typeof item !== 'number' || !Number.isFinite(item)) {
        throw invalid(`${path}.${key}`, 'must be a finite number');
      }
    } else if (typeof item !== 'boolean') {
      throw invalid(`${path}.${key}`, `must be a boolean (got ${describe(item)})`);
    }
    out[key] = item;
  }
  return out;
}

export function expectTags(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw invalid(path, `must be an array of strings (got ${describe(value)})`);
  }
  const seen = new Set<string>();
  for (const [i, tag] of value.entries()) {
    const text = expectNonBlank(tag, `${path}[${i}]`);
    if (seen.has(text)) {
      throw invalid(`${path}[${i}]`, `repeats the tag "${text}"`);
    }
    seen.add(text);
  }
  return Object.freeze([...seen]);
}

export function expectIdList(value: unknown, path: string): readonly Id[] {
  if (!Array.isArray(value)) {
    throw invalid(path, `must be an array of IDs (got ${describe(value)})`);
  }
  const seen = new Set<Id>();
  for (const [i, item] of value.entries()) {
    const id = expectId(item, `${path}[${i}]`);
    if (seen.has(id)) {
      throw invalid(`${path}[${i}]`, `repeats the ID "${id}"`);
    }
    seen.add(id);
  }
  return Object.freeze([...seen]);
}
