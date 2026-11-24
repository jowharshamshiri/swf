import type { PresetId } from './presets.js';
import { PRESETS, presetIssue } from './presets.js';
import { seedIssue } from './random.js';

/** The presentation backends a viewport can be shown with. */
export const BACKEND_IDS = ['dom', 'geometry'] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

/** How the application starts: which scene, from which seed, on which backend. */
export interface AppConfig {
  readonly preset: PresetId;
  readonly seed: number;
  readonly backend: BackendId;
}

export const DEFAULT_CONFIG: AppConfig = Object.freeze({
  preset: 'sparse',
  seed: PRESETS.sparse.defaultSeed,
  backend: 'dom',
});

/** A configuration value the application cannot use, by field. */
export class ConfigError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'ConfigError';
  }
}

const FIELDS = ['preset', 'seed', 'backend'] as const;

/**
 * The configuration an address's query names (`?preset=seam&seed=7&backend=geometry`), so a
 * scene can be linked to and reproduced. Anything left out takes its default (a preset's own seed
 * when only the preset is given); an unknown or invalid field is an error naming it.
 */
export function parseConfig(search: string): AppConfig {
  const params = new URLSearchParams(search);
  for (const key of new Set(params.keys())) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      throw new ConfigError(key, `unknown setting; the settings are ${FIELDS.join(', ')}`);
    }
    if (params.getAll(key).length > 1) {
      throw new ConfigError(key, 'given more than once');
    }
  }
  const presetText = params.get('preset');
  if (presetText !== null) {
    const issue = presetIssue(presetText);
    if (issue !== null) {
      throw new ConfigError('preset', issue);
    }
  }
  const preset = (presetText ?? DEFAULT_CONFIG.preset) as PresetId;
  const seedText = params.get('seed');
  let seed = PRESETS[preset].defaultSeed;
  if (seedText !== null) {
    seed = /^\d+$/.test(seedText) ? Number(seedText) : Number.NaN;
    const issue = seedIssue(seed);
    if (issue !== null) {
      throw new ConfigError('seed', issue);
    }
  }
  const backendText = params.get('backend');
  if (backendText !== null && !(BACKEND_IDS as readonly string[]).includes(backendText)) {
    throw new ConfigError('backend', `a backend must be one of ${BACKEND_IDS.join(', ')}`);
  }
  const backend = (backendText ?? DEFAULT_CONFIG.backend) as BackendId;
  return Object.freeze({ preset, seed, backend });
}
