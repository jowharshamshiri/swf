import { thrownText } from './errors.js';
import type { JsonValue } from './json.js';
import { describe, describeAnswer } from './json.js';
import { VERSIONED_ID } from './validate.js';

/**
 * What the scene needs to know of a projection to accept a viewport that uses it: its versioned ID
 * and how to check a configuration. The projection itself (its mapping and inverse) lives outside
 * the scene kernel.
 */
export interface ProjectionKind {
  /** A versioned ID, `<name>/<version>`, such as `equirectangular/1`. */
  readonly id: string;
  /**
   * Why `config` is invalid for this projection, or null when it is valid. It must be
   * deterministic and free of side effects; when it throws or answers anything but text or null,
   * the configuration is refused with `INVALID_INPUT` (or `SNAPSHOT_INVALID` on a restore), naming
   * the projection and quoting what it threw or answered.
   */
  configIssue(config: JsonValue): string | null;
}

/**
 * What `kind.configIssue` finds wrong with `config`, or null when it is valid. A configIssue that
 * throws or answers anything but text or null is reported as the issue, naming the projection.
 */
export function projectionConfigIssue(kind: ProjectionKind, config: JsonValue): string | null {
  let issue: unknown;
  try {
    issue = kind.configIssue(config);
  } catch (error) {
    return `projection "${kind.id}": its configIssue threw: ${thrownText(error)}`;
  }
  if (issue === null || typeof issue === 'string') {
    return issue;
  }
  return `projection "${kind.id}": its configIssue returned ${describeAnswer(issue)}, not text or null`;
}

/** The projection kinds a workspace accepts viewports for. */
export class ProjectionKindRegistry {
  readonly #kinds = new Map<string, ProjectionKind>();

  get(id: string): ProjectionKind | undefined {
    return this.#kinds.get(id);
  }

  /**
   * Adds a kind; throws a TypeError naming the problem when it is malformed or its ID is taken.
   * The returned function removes it (safe to call twice); viewports already using it keep their
   * settings, and new ones cannot choose it.
   */
  register(kind: ProjectionKind): () => void {
    const k: unknown = kind;
    if (typeof k !== 'object' || k === null) {
      throw new TypeError(`projection kind must be an object (got ${describe(k)})`);
    }
    const id = (k as { id?: unknown }).id;
    if (typeof id !== 'string' || !VERSIONED_ID.test(id)) {
      throw new TypeError(
        `projection kind id ${JSON.stringify(id)} must be a versioned ID "<name>/<version>"`,
      );
    }
    if (typeof (k as { configIssue?: unknown }).configIssue !== 'function') {
      throw new TypeError(`projection kind "${id}" must implement configIssue()`);
    }
    if (this.#kinds.has(id)) {
      throw new TypeError(`projection kind "${id}" is already registered`);
    }
    this.#kinds.set(id, kind);
    return () => {
      if (this.#kinds.get(id) === kind) {
        this.#kinds.delete(id);
      }
    };
  }
}
