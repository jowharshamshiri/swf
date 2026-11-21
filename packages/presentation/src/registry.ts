import type { SwfErrorCode } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type {
  CompositorCapabilities,
  ProjectionProfile,
  RendererCapabilities,
} from './capabilities.js';
import {
  compositorCapabilitiesIssue,
  isVersionedId,
  projectionProfileIssue,
  rendererCapabilitiesIssue,
} from './capabilities.js';
import type { Compositor, RendererBackend } from './contracts.js';
import { PRESENTATION_API_VERSION } from './contracts.js';
import type { ViewProjector } from './stages.js';

/** A registered module with the capabilities it declared when it was registered. */
export interface Registered<T, C> {
  readonly module: T;
  readonly capabilities: C;
}

/** Registration only: what a module that installs backends may do, and nothing else. */
export interface BackendRegistrar {
  /**
   * Each throws {@link SwfFailure}: `INVALID_INPUT` for a malformed module or a taken ID,
   * `UNSUPPORTED_CAPABILITY` for an incompatible contract version or invalid capabilities. The
   * returned function unregisters (safe to call twice).
   */
  registerRenderer(renderer: RendererBackend): () => void;
  registerCompositor(compositor: Compositor): () => void;
  registerProjector(projector: ViewProjector): () => void;
}

/** A listener that threw: the change it was told of stands, and the other listeners heard it. */
export interface RegistryDiagnostic {
  readonly code: 'LISTENER_THREW';
  readonly message: string;
  readonly details: Readonly<Record<string, string>>;
}

/** A module registered or unregistered. */
export interface RegistryChange {
  readonly kind: 'renderer' | 'compositor' | 'projector';
  readonly id: string;
  readonly registered: boolean;
}

/** The renderers, compositors and projectors available to a host's viewports. */
export interface PresentationRegistry extends BackendRegistrar {
  renderer(id: string): Registered<RendererBackend, RendererCapabilities> | undefined;
  compositor(id: string): Registered<Compositor, CompositorCapabilities> | undefined;
  projector(id: string): Registered<ViewProjector, ProjectionProfile> | undefined;
  rendererIds(): string[];
  compositorIds(): string[];
  projectorIds(): string[];
  /** A handle that can register and unregister backends but not read or use them. */
  registrar(): BackendRegistrar;
  /**
   * Calls `listener` after every registration and unregistration, in order. A listener that
   * throws does not stop the others; its failure is kept in {@link getDiagnostics}. Returns a
   * function that stops listening (safe to call twice).
   */
  subscribe(listener: (change: RegistryChange) => void): () => void;
  /** The last 100 listener failures, oldest first. */
  getDiagnostics(): readonly RegistryDiagnostic[];
}

export function createPresentationRegistry(): PresentationRegistry {
  return new Registry();
}

type Issue = { code: SwfErrorCode; message: string } | null;

function moduleIssue(value: unknown, kind: string, methods: readonly string[]): Issue {
  if (typeof value !== 'object' || value === null) {
    return { code: 'INVALID_INPUT', message: `${kind} must be an object` };
  }
  const m = value as Record<string, unknown>;
  if (!isVersionedId(m['id'])) {
    return {
      code: 'INVALID_INPUT',
      message: `${kind} id ${JSON.stringify(m['id'])} must be a versioned ID "<name>/<version>"`,
    };
  }
  const missing = methods.find((name) => typeof m[name] !== 'function');
  if (missing !== undefined) {
    return { code: 'INVALID_INPUT', message: `${kind} "${m['id']}" must implement ${missing}()` };
  }
  if (m['apiVersion'] !== PRESENTATION_API_VERSION) {
    return {
      code: 'UNSUPPORTED_CAPABILITY',
      message: `${kind} "${m['id']}" implements contract version ${JSON.stringify(m['apiVersion'])}, not ${String(PRESENTATION_API_VERSION)}`,
    };
  }
  return null;
}

class Registry implements PresentationRegistry {
  readonly #renderers = new Map<string, Registered<RendererBackend, RendererCapabilities>>();
  readonly #compositors = new Map<string, Registered<Compositor, CompositorCapabilities>>();
  readonly #projectors = new Map<string, Registered<ViewProjector, ProjectionProfile>>();
  readonly #listeners = new Set<(change: RegistryChange) => void>();
  readonly #diagnostics: RegistryDiagnostic[] = [];

  renderer(id: string) {
    return this.#renderers.get(id);
  }

  compositor(id: string) {
    return this.#compositors.get(id);
  }

  projector(id: string) {
    return this.#projectors.get(id);
  }

  rendererIds(): string[] {
    return [...this.#renderers.keys()];
  }

  compositorIds(): string[] {
    return [...this.#compositors.keys()];
  }

  projectorIds(): string[] {
    return [...this.#projectors.keys()];
  }

  registerRenderer(renderer: RendererBackend): () => void {
    this.#check(moduleIssue(renderer, 'renderer', ['capabilities', 'prepare']));
    const capabilities = this.#declared(renderer, 'renderer', rendererCapabilitiesIssue);
    return this.#add(this.#renderers, renderer.id, 'renderer', {
      module: renderer,
      capabilities,
    });
  }

  registerCompositor(compositor: Compositor): () => void {
    this.#check(moduleIssue(compositor, 'compositor', ['capabilities', 'prepare']));
    const capabilities = this.#declared(compositor, 'compositor', compositorCapabilitiesIssue);
    return this.#add(this.#compositors, compositor.id, 'compositor', {
      module: compositor,
      capabilities,
    });
  }

  registerProjector(projector: ViewProjector): () => void {
    const raw: unknown = projector;
    if (typeof raw !== 'object' || raw === null) {
      this.#check({ code: 'INVALID_INPUT', message: 'projector must be an object' });
    }
    if (typeof projector.project !== 'function') {
      this.#check({ code: 'INVALID_INPUT', message: 'projector must implement project()' });
    }
    const issue = projectionProfileIssue(projector.profile);
    if (issue !== null) {
      this.#check({ code: 'UNSUPPORTED_CAPABILITY', message: issue });
    }
    const profile = Object.freeze({ ...projector.profile });
    return this.#add(this.#projectors, profile.id, 'projector', {
      module: projector,
      capabilities: profile,
    });
  }

  subscribe(listener: (change: RegistryChange) => void): () => void {
    // Each subscription is its own entry, so subscribing one function twice needs two removals.
    const entry = (change: RegistryChange) => {
      listener(change);
    };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  getDiagnostics(): readonly RegistryDiagnostic[] {
    return Object.freeze([...this.#diagnostics]);
  }

  registrar(): BackendRegistrar {
    return Object.freeze({
      registerRenderer: (renderer: RendererBackend) => this.registerRenderer(renderer),
      registerCompositor: (compositor: Compositor) => this.registerCompositor(compositor),
      registerProjector: (projector: ViewProjector) => this.registerProjector(projector),
    });
  }

  #declared<C>(
    module: { readonly id: string; capabilities(): C },
    kind: string,
    issueOf: (value: unknown) => string | null,
  ): C {
    let declared: unknown;
    try {
      declared = module.capabilities();
    } catch (error) {
      this.#check({
        code: 'UNSUPPORTED_CAPABILITY',
        message: `${kind} "${module.id}" failed to report its capabilities: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const issue = issueOf(declared);
    if (issue !== null) {
      this.#check({ code: 'UNSUPPORTED_CAPABILITY', message: `${kind} "${module.id}": ${issue}` });
    }
    return deepFreeze(structuredCopy(declared)) as C;
  }

  #add<T>(map: Map<string, T>, id: string, kind: RegistryChange['kind'], entry: T): () => void {
    if (map.has(id)) {
      this.#check({ code: 'INVALID_INPUT', message: `a ${kind} "${id}" is already registered` });
    }
    map.set(id, entry);
    this.#notify({ kind, id, registered: true });
    return () => {
      if (map.get(id) === entry) {
        map.delete(id);
        this.#notify({ kind, id, registered: false });
      }
    };
  }

  #notify(change: RegistryChange): void {
    const frozen = Object.freeze(change);
    for (const listener of [...this.#listeners]) {
      try {
        listener(frozen);
      } catch (error) {
        // The registration stands and the other listeners still hear of it.
        this.#diagnostics.push(
          Object.freeze({
            code: 'LISTENER_THREW' as const,
            message: `a listener threw while handling the ${frozen.registered ? 'registration' : 'unregistration'} of ${frozen.kind} "${frozen.id}"`,
            details: Object.freeze({
              reason: error instanceof Error ? error.message : String(error),
            }),
          }),
        );
        this.#diagnostics.splice(0, this.#diagnostics.length - 100);
      }
    }
  }

  #check(issue: Issue): void {
    if (issue !== null) {
      throw new SwfFailure(makeError(issue.code, issue.message));
    }
  }
}

/** A copy of plain capability data, so the declaring module cannot change it afterwards. */
function structuredCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(structuredCopy);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, structuredCopy(v)]));
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}
