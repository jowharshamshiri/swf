import type { JsonValue, SceneState } from '@swf/core';
import { canonicalJson, jsonValue } from '@swf/core';
import type { DiagnosticsReport } from './diagnostics.js';
import type { Disclosure, OperationTrace } from './trace.js';
import { disclosureOf } from './trace.js';

/** What an export is made of, and what it may disclose. */
export interface DiagnosticsExportInput {
  /**
   * The report to export, as {@link Diagnostics.read} gave it. Its numbers, identifiers and error
   * codes are exported; backend capabilities are left out.
   */
  readonly report: DiagnosticsReport;
  /** The scene the export describes: where labels, binding keys and host data come from. */
  readonly scene: SceneState;
  /**
   * The operation trace to include, if any, serialized with the export's disclosure. It is read,
   * not cleared or disposed.
   */
  readonly trace?: OperationTrace;
  /**
   * The host's own measures, by section name: identifiers and numbers only, which it vouches
   * for. They are included as they are, so they must hold nothing the disclosure would withhold.
   */
  readonly measures?: Readonly<Record<string, unknown>>;
  /**
   * What to disclose; everything not named stays private. Default {@link PRIVATE_DISCLOSURE}.
   */
  readonly disclosure?: Partial<Disclosure>;
  /** When the export was made, in milliseconds since the epoch; finite. */
  readonly exportedAt: number;
}

/**
 * Diagnostics as a JSON document to save or share (AN-011, PRIV-003, AN-009): by default
 * identifiers, performance numbers and error codes only. Labels, binding keys and the host's tags
 * and metadata are added only when disclosed, each in its own section (`labels`, `bindings`,
 * `hostData`) keyed by ID, and error messages beside their codes, so what was shared is plain to
 * see; the `disclosed` field says what was chosen. Timings disclosed add the trace's timestamps
 * and durations; the report's own measures are always included. It never walks a surface's
 * content: only the scene's own records and the measures given. It sends nothing anywhere.
 *
 * @returns Canonical JSON text, keys sorted and indented by two spaces, of the format
 *   `swf.diagnostics/1`.
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` for an invalid disclosure (naming
 *   `disclosure.<field>`), measures that are not JSON data (naming the path under `measures`), or
 *   an `exportedAt` that is `NaN` or infinite (naming `export.exportedAt`).
 */
export function exportDiagnostics(input: DiagnosticsExportInput): string {
  const open = disclosureOf(input.disclosure ?? {});
  const { report, scene } = input;
  const nodes = [...scene.nodes.values()];
  const surfaces = [...scene.surfaces.values()];
  const body: Record<string, JsonValue> = {
    export: 'swf.diagnostics/1',
    workspaceId: scene.workspaceId,
    revision: scene.revision,
    exportedAt: input.exportedAt,
    disclosed: { ...open },
    backends: report.backends.map((b) => ({
      viewportId: b.viewportId,
      state: b.state,
      renderer: b.backend?.renderer ?? null,
      compositor: b.backend?.compositor ?? null,
      degradedBy: b.degradedBy === null ? null : errorOf(b.degradedBy, open),
    })),
    fallbacks: report.fallbacks.map((f) => ({
      viewportId: f.viewportId,
      count: f.count,
      surfaceIds: [...f.surfaceIds],
      chosen: f.example.chosen,
      preferred: f.example.preferred,
      requirements: [...new Set(f.example.gaps.map((g) => g.requirement))],
    })),
    frames: report.frames.map((f) => ({ ...f, lastDirty: [...f.lastDirty] })),
    attachments: report.attachments.map((a) => ({
      ...a,
      bindMs: a.bindMs === null ? null : { ...a.bindMs },
      fallbacks: { ...a.fallbacks },
    })),
    density: {
      nodes: report.density.nodes,
      surfaces: report.density.surfaces,
      viewports: report.density.viewports.map((v) => ({ ...v })),
    },
    operations: report.operations.map((o) => ({ ...o })),
    resources: {
      ...report.resources,
      presenter: { ...report.resources.presenter },
    },
    errors: report.errors.map((e) => ({ at: e.at, source: e.source, ...errorOf(e.error, open) })),
    listenerFailures: report.listenerFailures,
  };
  if (open.labels) {
    body['labels'] = {
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n.label])),
      surfaces: Object.fromEntries(surfaces.map((s) => [s.id, s.label])),
    };
  }
  if (open.bindingKeys) {
    body['bindings'] = Object.fromEntries(
      surfaces.map((s) => [s.id, { bindingKey: s.bindingKey, adapterTypeId: s.adapterTypeId }]),
    );
  }
  if (open.hostData) {
    body['hostData'] = Object.fromEntries(
      nodes.map((n) => [n.id, { tags: [...n.tags], metadata: n.metadata }]),
    );
  }
  if (input.trace !== undefined) {
    body['trace'] = JSON.parse(input.trace.serialize(open)) as JsonValue;
  }
  if (input.measures !== undefined) {
    body['measures'] = jsonValue(input.measures, 'measures');
  }
  return JSON.stringify(canonicalJson(jsonValue(body, 'export')), null, 2);
}

/** An error as an export holds it: its code and where, and its message only when disclosed. */
function errorOf(
  error: {
    readonly code: string;
    readonly entityId?: string;
    readonly path?: string;
    readonly message: string;
  },
  open: Disclosure,
): Record<string, JsonValue> {
  return {
    code: error.code,
    entityId: error.entityId ?? null,
    path: error.path ?? null,
    ...(open.messages ? { message: error.message } : {}),
  };
}
