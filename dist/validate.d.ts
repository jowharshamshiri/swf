import type { Quat, Transform3D, Vec3 } from '@swf/math';
import { RejectionSignal } from './errors.js';
import type { EntityFlags, Id, InteractionRegion } from './model.js';
/**
 * A versioned ID: a name and a positive integer version, such as `host.video/1`. Adapter types,
 * projection kinds, renderers and compositors are named this way.
 */
export declare const VERSIONED_ID: RegExp;
export declare function expectVersionedId(value: unknown, path: string): string;
export declare function expectPositive(value: unknown, path: string): number;
/** A validated, frozen unit quaternion, renormalized like transform rotations. */
export declare function expectRotation(value: unknown, path: string): Quat;
/** A binding key is opaque: any non-blank string, or null for none. It is never interpreted. */
export declare function expectBindingKey(value: unknown, path: string): string | null;
export declare function expectInteraction(value: unknown, path: string): InteractionRegion;
/** Quaternions within this distance of unit length are accepted and stored normalized. */
export declare const QUAT_TOLERANCE = 0.000001;
export declare function invalid(path: string, message: string): RejectionSignal;
/** A plain object whose keys are all in `allowed`; an unknown key is rejected by name. */
export declare function expectRecord(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown>;
export declare function expectId(value: unknown, path: string): Id;
export declare function expectIdOrNull(value: unknown, path: string): Id | null;
export declare function expectNonBlank(value: unknown, path: string): string;
export declare function expectLabel(value: unknown, path: string): string | null;
export declare function expectIndex(value: unknown, path: string, max: number): number;
export declare function expectVec3(value: unknown, path: string): Vec3;
export declare function expectBounds(value: unknown, path: string): Vec3;
/** A validated copy of a transform with its rotation renormalized. */
export declare function expectTransform(value: unknown, path: string): Transform3D;
export declare function expectFlags(value: unknown, path: string): Partial<EntityFlags>;
export declare function expectTags(value: unknown, path: string): readonly string[];
export declare function expectIdList(value: unknown, path: string): readonly Id[];
//# sourceMappingURL=validate.d.ts.map