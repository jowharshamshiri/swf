import type { Id, JsonValue } from '@swf/core';
import { jsonValue, SwfFailure } from '@swf/core';

/** Modifier keys held during an intent. */
export interface Modifiers {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export type ModifierKey = keyof Modifiers;

export const NO_MODIFIERS: Modifiers = Object.freeze({
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
});

/** What kind of device produced a pointer. `virtual` is a pointer driven by software. */
export type PointerType = 'mouse' | 'touch' | 'pen' | 'virtual';

/**
 * Where a pointer is in its stroke. `cancel` means the platform took the pointer away (its capture
 * was lost); it ends any gesture the pointer drives without committing it.
 */
export type PointerPhase = 'down' | 'move' | 'up' | 'cancel';

/**
 * A pointer sample in a viewport. Positions are in the viewport's CSS pixels; they may lie outside
 * the viewport while a captured pointer travels beyond it.
 */
export interface PointerIntent {
  readonly kind: 'pointer';
  readonly viewportId: Id;
  /** The input device, stable for as long as it is connected. */
  readonly deviceId: string;
  /** The pointer, stable from its `down` to its `up` or `cancel`. */
  readonly pointerId: number;
  readonly pointerType: PointerType;
  readonly phase: PointerPhase;
  readonly x: number;
  readonly y: number;
  /** Pressed buttons as a bit mask (1 primary, 2 secondary, 4 auxiliary). */
  readonly buttons: number;
  readonly modifiers: Modifiers;
  /** Milliseconds on the host's monotonic clock. */
  readonly timestamp: number;
  /** Normalized pressure in [0, 1], when the device reports it. */
  readonly pressure?: number;
  /** Pen tilt in degrees, each in [-90, 90], when the device reports it. */
  readonly tilt?: { readonly x: number; readonly y: number };
  /** Pen rotation about its axis in degrees, in [0, 360), when the device reports it. */
  readonly twist?: number;
}

/** A wheel or trackpad scroll over a viewport point. */
export interface WheelIntent {
  readonly kind: 'wheel';
  readonly viewportId: Id;
  readonly deviceId: string;
  readonly x: number;
  readonly y: number;
  /** Scroll amounts in CSS pixels. */
  readonly deltaX: number;
  readonly deltaY: number;
  readonly modifiers: Modifiers;
  readonly timestamp: number;
}

/**
 * A key press or release. `focus` says where keyboard focus is: in the workspace's own controls,
 * or in a surface's content, whose keys stay with the content.
 */
export interface KeyIntent {
  readonly kind: 'key';
  /** The viewport the key applies to, or null when it applies to none in particular. */
  readonly viewportId: Id | null;
  readonly deviceId: string;
  readonly phase: 'down' | 'up';
  /** The key's value, as the platform names it (for example `ArrowLeft`, `Escape`, `z`). */
  readonly key: string;
  readonly repeat: boolean;
  readonly modifiers: Modifiers;
  readonly focus: 'workspace' | 'content';
  readonly timestamp: number;
}

/** A spatial operation requested by name, from a keyboard binding, a control or a program. */
export interface CommandIntent {
  readonly kind: 'command';
  readonly command: string;
  readonly args: JsonValue;
  readonly deviceId: string;
  readonly timestamp: number;
}

/** Every input reaches the router as one of these; devices differ only in their adapters. */
export type InputIntent = PointerIntent | WheelIntent | KeyIntent | CommandIntent;

const POINTER_TYPES: readonly string[] = ['mouse', 'touch', 'pen', 'virtual'];
const POINTER_PHASES: readonly string[] = ['down', 'move', 'up', 'cancel'];

const FIELDS: Record<InputIntent['kind'], { required: string[]; optional: string[] }> = {
  pointer: {
    required: [
      'kind',
      'viewportId',
      'deviceId',
      'pointerId',
      'pointerType',
      'phase',
      'x',
      'y',
      'buttons',
      'modifiers',
      'timestamp',
    ],
    optional: ['pressure', 'tilt', 'twist'],
  },
  wheel: {
    required: [
      'kind',
      'viewportId',
      'deviceId',
      'x',
      'y',
      'deltaX',
      'deltaY',
      'modifiers',
      'timestamp',
    ],
    optional: [],
  },
  key: {
    required: [
      'kind',
      'viewportId',
      'deviceId',
      'phase',
      'key',
      'repeat',
      'modifiers',
      'focus',
      'timestamp',
    ],
    optional: [],
  },
  command: { required: ['kind', 'command', 'args', 'deviceId', 'timestamp'], optional: [] },
};

const nonBlank = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Why a value is not a valid intent, naming the field, or null when it is valid. Intents come from
 * adapters that may be plain JavaScript, so nothing is assumed.
 */
export function intentIssue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'an intent must be an object';
  }
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (kind !== 'pointer' && kind !== 'wheel' && kind !== 'key' && kind !== 'command') {
    return `kind must be pointer, wheel, key or command (got ${JSON.stringify(kind)})`;
  }
  const { required, optional } = FIELDS[kind];
  const missing = required.find((k) => !(k in record));
  if (missing !== undefined) {
    return `${missing} is required`;
  }
  const unknown = Object.keys(record).find((k) => !required.includes(k) && !optional.includes(k));
  if (unknown !== undefined) {
    return `${unknown} is not a field of a ${kind} intent`;
  }
  if (!nonBlank(record['deviceId'])) {
    return 'deviceId must be a non-blank string';
  }
  if (!finite(record['timestamp']) || record['timestamp'] < 0) {
    return 'timestamp must be a non-negative finite number';
  }
  if (kind !== 'command') {
    const modifiers = modifiersIssue(record['modifiers']);
    if (modifiers !== null) {
      return modifiers;
    }
  }
  switch (kind) {
    case 'pointer':
      return pointerIssue(record);
    case 'wheel':
      if (!nonBlank(record['viewportId'])) {
        return 'viewportId must be a non-blank string';
      }
      for (const k of ['x', 'y', 'deltaX', 'deltaY']) {
        if (!finite(record[k])) {
          return `${k} must be a finite number`;
        }
      }
      return null;
    case 'key':
      if (record['viewportId'] !== null && !nonBlank(record['viewportId'])) {
        return 'viewportId must be null or a non-blank string';
      }
      if (record['phase'] !== 'down' && record['phase'] !== 'up') {
        return 'phase must be down or up';
      }
      if (typeof record['key'] !== 'string' || record['key'] === '') {
        return 'key must be a non-empty string';
      }
      if (typeof record['repeat'] !== 'boolean') {
        return 'repeat must be a boolean';
      }
      if (record['focus'] !== 'workspace' && record['focus'] !== 'content') {
        return 'focus must be workspace or content';
      }
      return null;
    case 'command':
      if (!nonBlank(record['command'])) {
        return 'command must be a non-blank string';
      }
      try {
        jsonValue(record['args'], 'args');
      } catch (error) {
        if (error instanceof SwfFailure) {
          return error.message;
        }
        throw error;
      }
      return null;
  }
}

function modifiersIssue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'modifiers must be an object { shift, ctrl, alt, meta }';
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(NO_MODIFIERS)) {
    if (typeof record[key] !== 'boolean') {
      return `modifiers.${key} must be a boolean`;
    }
  }
  const extra = Object.keys(record).find((k) => !(k in NO_MODIFIERS));
  return extra === undefined ? null : `modifiers.${extra} is not a modifier`;
}

function pointerIssue(record: Record<string, unknown>): string | null {
  if (!nonBlank(record['viewportId'])) {
    return 'viewportId must be a non-blank string';
  }
  const pointerId = record['pointerId'];
  if (!Number.isInteger(pointerId) || (pointerId as number) < 0) {
    return 'pointerId must be a non-negative integer';
  }
  if (!POINTER_TYPES.includes(record['pointerType'] as string)) {
    return `pointerType must be one of ${POINTER_TYPES.join(', ')}`;
  }
  if (!POINTER_PHASES.includes(record['phase'] as string)) {
    return `phase must be one of ${POINTER_PHASES.join(', ')}`;
  }
  if (!finite(record['x']) || !finite(record['y'])) {
    return 'x and y must be finite numbers';
  }
  const buttons = record['buttons'];
  if (!Number.isInteger(buttons) || (buttons as number) < 0) {
    return 'buttons must be a non-negative integer bit mask';
  }
  const pressure = record['pressure'];
  if (pressure !== undefined && !(finite(pressure) && pressure >= 0 && pressure <= 1)) {
    return 'pressure must be a number in [0, 1]';
  }
  const tilt = record['tilt'];
  if (tilt !== undefined) {
    const t = tilt as Record<string, unknown> | null;
    const angle = (v: unknown) => finite(v) && v >= -90 && v <= 90;
    if (
      typeof t !== 'object' ||
      t === null ||
      Object.keys(t).length !== 2 ||
      !angle(t['x']) ||
      !angle(t['y'])
    ) {
      return 'tilt must be { x, y } in degrees, each in [-90, 90]';
    }
  }
  const twist = record['twist'];
  if (twist !== undefined && !(finite(twist) && twist >= 0 && twist < 360)) {
    return 'twist must be a number of degrees in [0, 360)';
  }
  return null;
}
