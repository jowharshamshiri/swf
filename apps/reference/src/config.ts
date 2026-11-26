import type { PresetId } from './presets.js';
import { PRESETS, presetIssue } from './presets.js';
import { seedIssue } from '@swf/math';
import type { BackendId } from '@swf/navigation';
import { BACKEND_IDS } from '@swf/navigation';

/** How the application starts: which scene, from which seed, on which backend. */
export interface AppConfig {
  readonly preset: PresetId;
  readonly seed: number;
  readonly backend: BackendId;
  /**
   * Whether the space shown last is shown as it was left, rather than with the preset loaded into
   * it: so when the address names no scene (UX-016).
   */
  readonly restore: boolean;
}

/**
 * The studio on the geometry backend: its notes are placed live in the page and its tiles are
 * drawn, so every window, focused or not, shows what it holds. The DOM backend, which places live
 * elements and never draws, shows tiles by their stand-ins; it is the geometry backend's fallback.
 */
export const DEFAULT_CONFIG: AppConfig = Object.freeze({
  preset: 'studio',
  seed: PRESETS.studio.defaultSeed,
  backend: 'geometry',
  restore: true,
});

/**
 * The spaces the application seeds, each from a preset, in the order they are listed: each is one
 * of the spaces from the first visit on, made from its preset until it is stored.
 */
export const SEEDED_SPACES: readonly { readonly name: string; readonly preset: PresetId }[] =
  Object.freeze([
    Object.freeze({ name: 'Research', preset: 'research' }),
    Object.freeze({ name: 'Planning', preset: 'planning' }),
    Object.freeze({ name: 'Studio', preset: 'studio' }),
  ]);

/** The space a first visit shows: the studio's, the demo (D9). */
export const DEFAULT_SPACE = 'Studio';

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
 * when only the preset is given); an unknown or invalid field is an error naming it. An address
 * that names a preset or a seed loads that scene into the space shown; one that names neither
 * shows the space as it was left.
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
  return Object.freeze({
    preset,
    seed,
    backend,
    restore: presetText === null && seedText === null,
  });
}
