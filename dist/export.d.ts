import type { SceneState } from '@swf/core';
import type { DiagnosticsReport } from './diagnostics.js';
import type { Disclosure, OperationTrace } from './trace.js';
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
export declare function exportDiagnostics(input: DiagnosticsExportInput): string;
//# sourceMappingURL=export.d.ts.map