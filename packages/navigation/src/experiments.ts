import { models } from '@swf/models';
import type { FeatureId } from './features.js';

/**
 * Navigation's experiments: each of its eight capabilities tried alone, or all of
 * them together, as the experiment panel offers them. An experiment is configuration and nothing
 * else: it turns the feature modules on or off through the policies' own `configure`, and sets the
 * view up to show the capability it isolates (the view mode, what a drag on the panorama's
 * background turns, the whole circle in view) through the modes and the orbit policy. It never
 * changes a window, and holds none of a capability's behaviour: that stays in its module. Which
 * modules an experiment turns on, how its view is set up from what the scene offers, and which
 * experiment a combination of switches is (none for a custom one) are the Lean model
 * `Swf.AppExperiments` (models/Swf/AppExperiments.lean).
 */

/** The experiments, by stable ID, in the order they are offered: every capability, then 01 to 08. */
export const EXPERIMENT_IDS = [
  'everything',
  'focus',
  'orbit',
  'depth',
  'cursor',
  'map',
  'snap',
  'composition',
  'persistence',
] as const;
/** An experiment, by its ID: `everything`, or one capability alone. */
export type ExperimentId = (typeof EXPERIMENT_IDS)[number];

/** The capabilities in the order the experiments number them: the switches' order in the panel. */
export const CAPABILITY_ORDER: readonly FeatureId[] = Object.freeze([
  'focus',
  'orbit',
  'depth',
  'cursor',
  'map',
  'snap',
  'composition',
  'persistence',
]);

/** What the panel says of an experiment. */
export interface Experiment {
  /** Its ID. */
  readonly id: ExperimentId;
  /** Its number: ∞ for every capability together, else 01 to 08. */
  readonly number: string;
  /** Its name, as the ID of the message a host's interface names it by. */
  readonly name: `experiment.${ExperimentId}`;
  /** What it shows, in a line, as the ID of the message that says it. */
  readonly summary: `experiment.${ExperimentId}.summary`;
  /** What to try, and what to turn off to compare the behaviour without it, as a message's ID. */
  readonly trial: `experiment.${ExperimentId}.trial`;
}

const experiment = (id: ExperimentId, number: string): Experiment =>
  Object.freeze({
    id,
    number,
    name: `experiment.${id}`,
    summary: `experiment.${id}.summary`,
    trial: `experiment.${id}.trial`,
  });

/** Every experiment, by its ID, numbered in the order of {@link EXPERIMENT_IDS}. */
export const EXPERIMENTS: Readonly<Record<ExperimentId, Experiment>> = Object.freeze(
  Object.fromEntries(
    EXPERIMENT_IDS.map((id, index) => [
      id,
      experiment(id, index === 0 ? '∞' : String(index).padStart(2, '0')),
    ]),
  ) as Record<ExperimentId, Experiment>,
);

/** The experiment a combination of the modules is, or null for a custom combination. */
export function experimentOf(enabled: Readonly<Record<FeatureId, boolean>>): ExperimentId | null {
  return models.experimentOf(enabled)?.kind ?? null;
}

/** What the scene offers an experiment's setup. */
export interface ExperimentContext {
  /** A window is selected or focused, which focus can show. */
  readonly target: boolean;
  /** A group is designated for workspace orbit. */
  readonly orbitRoot: boolean;
}

/** An experiment as it is applied: the modules on, and the view set up to show it. */
export interface ExperimentPlan {
  /** Whether each capability is on. */
  readonly enabled: Readonly<Record<FeatureId, boolean>>;
  /** The view mode it is shown in. */
  readonly view: 'panorama' | 'focus' | 'map';
  /** What a drag on the panorama's background turns. */
  readonly navigation: 'camera' | 'orbit';
  /** Whether the panorama is widened to the whole circle, which wrapping at the seam needs. */
  readonly wholeCircle: boolean;
}

/** How an experiment is applied in a scene that offers `context`. */
export function experimentPlan(id: ExperimentId, context: ExperimentContext): ExperimentPlan {
  const plan = models.experimentPlan({ kind: id }, context);
  return Object.freeze({
    enabled: Object.freeze({ ...plan.enabled }),
    view: plan.view.kind,
    navigation: plan.navigation.kind,
    wholeCircle: plan.wholeCircle,
  });
}
