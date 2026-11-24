import type { Id, SceneState, WorkspaceReader } from '@swf/core';
import { ancestorIds, findNodes, fold, worldMatrix } from '@swf/core';

/**
 * Finding windows by what the workspace says about them: their IDs, labels and tags, the
 * descriptive metadata the host exposes, and the groups they are in. It never looks at what a
 * window shows. Matching is the kernel's (`findNodes`: Unicode-normalized, case-insensitive
 * substrings); this module adds the filters only the application can answer (how each window's
 * surface is attached, whether the viewport shows it), sorting, a debounce for typing, and pages.
 */

/** Results are read a page at a time; the list shows them as it scrolls, never cut short. */
export const PAGE_SIZE = 50;

/** How long typing must pause before the query runs, by default (in milliseconds). */
export const DEFAULT_DEBOUNCE_MS = 100;

export const SORT_KEYS = ['recent', 'label', 'distance', 'group', 'id'] as const;
/**
 * `recent`: most recently focused first (never-focused last); `label`; `distance` from the
 * camera; `group`: by the path of groups a window is in; `id`. Ties go by label, then ID.
 */
export type SortKey = (typeof SORT_KEYS)[number];

export const VISIBILITY_FILTERS = ['any', 'visible', 'hidden'] as const;
export const LOCK_FILTERS = ['any', 'locked', 'unlocked'] as const;
export const ATTACHMENT_FILTERS = ['any', 'attached', 'pending', 'unbound', 'failed'] as const;
export const COVERAGE_FILTERS = ['any', 'in-view', 'out-of-view'] as const;

/** How a window's content is attached: shown or ready, on its way, not bound, or failed. */
export type Attachment = Exclude<(typeof ATTACHMENT_FILTERS)[number], 'any'>;
/** Whether the viewport shows any of a window. */
export type Coverage = Exclude<(typeof COVERAGE_FILTERS)[number], 'any'>;

export interface SearchFilters {
  /** Only windows inside this group (at any depth), or null for any. */
  readonly group: Id | null;
  /** By effective visibility, inherited from the groups a window is in. */
  readonly visibility: (typeof VISIBILITY_FILTERS)[number];
  readonly lock: (typeof LOCK_FILTERS)[number];
  readonly attachment: (typeof ATTACHMENT_FILTERS)[number];
  readonly coverage: (typeof COVERAGE_FILTERS)[number];
}

export interface SearchQuery {
  readonly text: string;
  readonly filters: SearchFilters;
  readonly sort: SortKey;
  /** The sort key runs the other way; ties still go by label, then ID. */
  readonly descending: boolean;
}

export const NO_FILTERS: SearchFilters = Object.freeze({
  group: null,
  visibility: 'any',
  lock: 'any',
  attachment: 'any',
  coverage: 'any',
});

export const DEFAULT_QUERY: SearchQuery = Object.freeze({
  text: '',
  filters: NO_FILTERS,
  sort: 'recent',
  descending: false,
});

/** A window found, as a result row shows it. */
export interface SearchResult {
  readonly id: Id;
  readonly label: string;
  /** The labels (or IDs) of the groups it is in, outermost first. */
  readonly groups: readonly string[];
  readonly tags: readonly string[];
  readonly attachment: Attachment;
  readonly coverage: Coverage;
  /** World units from the camera. */
  readonly distance: number;
}

/** A group a window can be in, as the group filter offers it. */
export interface GroupOption {
  readonly id: Id;
  readonly label: string;
}

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SearchOptions {
  readonly workspace: WorkspaceReader;
  readonly viewportId: Id;
  /** The host-exposed metadata keys the text also matches. */
  readonly metadataKeys: readonly string[];
  /** How a window's content is attached now. */
  attachment(state: SceneState, nodeId: Id): Attachment;
  /** Whether the viewport shows any of a window now. */
  coverage(state: SceneState, nodeId: Id): Coverage;
  /**
   * Other changes the results depend on (content attaching and detaching, frames presented):
   * called with a function that refreshes them; returns the function that stops it.
   */
  watch?(refresh: () => void): () => void;
  /** Default {@link DEFAULT_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  readonly timers?: Timers;
}

export interface Search {
  /** The query results are for; `typed` is the text as typed, ahead of it while it settles. */
  query(): SearchQuery;
  typed(): string;
  /** Typing is waiting for its pause. */
  pending(): boolean;
  /** Text as it is typed: the query takes it once typing pauses for the debounce. */
  setText(text: string): void;
  setFilters(filters: Partial<SearchFilters>): void;
  setSort(sort: SortKey, descending?: boolean): void;
  /** Every filter back to none; the text stays. */
  clearFilters(): void;
  /** The text, the filters and the sort back to their defaults. */
  reset(): void;
  /** The IDs found, in order: the whole list, however long. */
  ids(): readonly Id[];
  /** How many pages the results take. */
  pageCount(): number;
  /** One page of results, read when it is shown. */
  page(index: number): readonly SearchResult[];
  /** The groups of the scene, for the group filter. */
  groups(): readonly GroupOption[];
  /** Called whenever the query or the results change. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

const browserTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Names in reading order: numbers in them by their value, so "Note 9" comes before "Note 10". */
const names = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' });

function compareName(a: string, b: string): number {
  return names.compare(a, b) || compareText(a, b);
}

/** Throws for a value outside its list, naming the field. */
function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new RangeError(
      `${field} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
  return value as T;
}

export function createSearch(options: SearchOptions): Search {
  const { workspace, viewportId, metadataKeys } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  if (!(Number.isFinite(debounceMs) && debounceMs >= 0)) {
    throw new RangeError(
      `debounceMs must be a number of milliseconds, 0 or more (got ${String(debounceMs)})`,
    );
  }
  const timers = options.timers ?? browserTimers;
  const listeners = new Set<() => void>();
  let query: SearchQuery = DEFAULT_QUERY;
  let typed = '';
  let timer: unknown = null;
  /** Each window's last focus, as a rising sequence number: the latest is the largest. */
  const focusedAt = new Map<Id, number>();
  let focusCount = 0;
  let lastFocused: Id | null = workspace.getState().focusedId;
  if (lastFocused !== null) {
    focusedAt.set(lastFocused, ++focusCount);
  }
  let found: { ids: readonly Id[]; rows: Map<Id, SearchResult> } | null = null;
  const pages = new Map<number, readonly SearchResult[]>();

  const announce = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const invalidate = () => {
    found = null;
    pages.clear();
    announce();
  };

  const groupsOf = (state: SceneState, id: Id): string[] =>
    ancestorIds(state.nodes, id)
      .reverse()
      .map((groupId) => state.nodes.get(groupId)?.label ?? groupId);

  const rowOf = (state: SceneState, id: Id): SearchResult => {
    const node = state.nodes.get(id);
    if (node === undefined) {
      throw new Error(`no node "${id}"`);
    }
    const viewport = state.viewports.get(viewportId);
    const camera = viewport === undefined ? undefined : state.cameras.get(viewport.cameraId);
    if (camera === undefined) {
      throw new Error(`viewport "${viewportId}" has no camera`);
    }
    const world = worldMatrix(state.nodes, id);
    const [x, y, z] =
      world === undefined ? node.transform.position : [world[12], world[13], world[14]];
    const [ex, ey, ez] = camera.position;
    return Object.freeze({
      id,
      label: node.label ?? node.id,
      groups: Object.freeze(groupsOf(state, id)),
      tags: node.tags,
      attachment: options.attachment(state, id),
      coverage: options.coverage(state, id),
      distance: Math.hypot(x - ex, y - ey, z - ez),
    });
  };

  const run = () => {
    if (found !== null) {
      return found;
    }
    const state = workspace.getState();
    const { text, filters } = query;
    const ids = findNodes(state, {
      kinds: ['window'],
      ...(text.trim() === '' ? {} : { text: text.trim(), metadataKeys, groupPath: true }),
      ...(filters.group === null ? {} : { within: filters.group }),
      ...(filters.visibility === 'any' ? {} : { visible: filters.visibility === 'visible' }),
      ...(filters.lock === 'any' ? {} : { locked: filters.lock === 'locked' }),
    });
    const rows = new Map<Id, SearchResult>();
    for (const id of ids) {
      const row = rowOf(state, id);
      if (
        (filters.attachment === 'any' || row.attachment === filters.attachment) &&
        (filters.coverage === 'any' || row.coverage === filters.coverage)
      ) {
        rows.set(id, row);
      }
    }
    const label = (row: SearchResult) => fold(row.label);
    const group = (row: SearchResult) => row.groups.map(fold).join('\u0000');
    const primary: (a: SearchResult, b: SearchResult) => number = {
      recent: (a: SearchResult, b: SearchResult) =>
        (focusedAt.get(b.id) ?? 0) - (focusedAt.get(a.id) ?? 0),
      label: (a: SearchResult, b: SearchResult) => compareName(label(a), label(b)),
      distance: (a: SearchResult, b: SearchResult) => a.distance - b.distance,
      group: (a: SearchResult, b: SearchResult) => compareName(group(a), group(b)),
      id: (a: SearchResult, b: SearchResult) => compareText(a.id, b.id),
    }[query.sort];
    const direction = query.descending ? -1 : 1;
    const ordered = [...rows.values()].sort(
      (a, b) =>
        direction * primary(a, b) || compareName(label(a), label(b)) || compareText(a.id, b.id),
    );
    found = { ids: Object.freeze(ordered.map((row) => row.id)), rows };
    return found;
  };

  const unwatchScene = workspace.subscribe((event) => {
    if (event.type !== 'transaction.committed') {
      return;
    }
    const focused = workspace.getState().focusedId;
    if (focused !== lastFocused) {
      lastFocused = focused;
      if (focused !== null) {
        focusedAt.set(focused, ++focusCount);
      }
    }
    invalidate();
  });
  const unwatchOther = options.watch?.(invalidate) ?? (() => undefined);

  const setQuery = (next: SearchQuery) => {
    query = Object.freeze(next);
    invalidate();
  };

  return Object.freeze({
    query: () => query,
    typed: () => typed,
    pending: () => timer !== null,
    setText(text: string) {
      if (typeof text !== 'string') {
        throw new TypeError('text must be a string');
      }
      typed = text;
      if (timer !== null) {
        timers.clear(timer);
      }
      timer = timers.set(() => {
        timer = null;
        setQuery({ ...query, text: typed });
      }, debounceMs);
      announce();
    },
    setFilters(filters: Partial<SearchFilters>) {
      const next: SearchFilters = { ...query.filters, ...filters };
      if (next.group !== null && workspace.getState().nodes.get(next.group)?.kind !== 'group') {
        throw new RangeError(
          `group must name a group of the scene (got ${JSON.stringify(next.group)})`,
        );
      }
      setQuery({
        ...query,
        filters: Object.freeze({
          group: next.group,
          visibility: oneOf('visibility', next.visibility, VISIBILITY_FILTERS),
          lock: oneOf('lock', next.lock, LOCK_FILTERS),
          attachment: oneOf('attachment', next.attachment, ATTACHMENT_FILTERS),
          coverage: oneOf('coverage', next.coverage, COVERAGE_FILTERS),
        }),
      });
    },
    setSort(sort: SortKey, descending = false) {
      setQuery({ ...query, sort: oneOf('sort', sort, SORT_KEYS), descending });
    },
    clearFilters() {
      setQuery({ ...query, filters: NO_FILTERS });
    },
    reset() {
      if (timer !== null) {
        timers.clear(timer);
        timer = null;
      }
      typed = '';
      setQuery(DEFAULT_QUERY);
    },
    ids: () => run().ids,
    pageCount: () => Math.ceil(run().ids.length / PAGE_SIZE),
    page(index: number) {
      const { ids, rows } = run();
      if (!Number.isInteger(index) || index < 0 || (index > 0 && index * PAGE_SIZE >= ids.length)) {
        throw new RangeError(
          `page must be a whole number below ${String(Math.ceil(ids.length / PAGE_SIZE))} (got ${String(index)})`,
        );
      }
      let page = pages.get(index);
      if (page === undefined) {
        page = Object.freeze(
          ids.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE).map((id) => {
            const row = rows.get(id);
            if (row === undefined) {
              throw new Error(`result "${id}" has no row`);
            }
            return row;
          }),
        );
        pages.set(index, page);
      }
      return page;
    },
    groups() {
      const state = workspace.getState();
      return findNodes(state, { kinds: ['group'] })
        .map((id) => ({
          id,
          label: [...groupsOf(state, id), state.nodes.get(id)?.label ?? id].join(' / '),
        }))
        .sort((a, b) => compareName(fold(a.label), fold(b.label)) || compareText(a.id, b.id));
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (timer !== null) {
        timers.clear(timer);
        timer = null;
      }
      unwatchScene();
      unwatchOther();
      listeners.clear();
    },
  });
}
