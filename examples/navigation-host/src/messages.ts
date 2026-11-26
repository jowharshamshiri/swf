import type { Messages } from '@swf/navigation-ui';
import { createMessages, NAVIGATION_ENGLISH } from '@swf/navigation-ui';

/** What the host itself says, beside the navigation controls' words. */
const OWN = Object.freeze({
  'host.title': 'Workbench',
  'host.components': 'Components',
  'host.components.detail':
    'Each navigation control is on its own: turn one off and the rest work on; replace the view controls with the host’s own.',
  'host.component.radar': 'Radar',
  'host.component.inspector': 'Inspector',
  'host.component.controls': 'View controls',
  'host.component.controls.own': 'The host’s own view controls in their place',
  'host.component.strip': 'Focus strip',
  'host.component.map': 'Map',
  'host.component.overview': 'Overview',
  'host.component.experiments': 'Experiment panel',
  'host.component.switcher': 'View switcher',
  'host.experiments': 'Experiments',
  'host.experiments.off': 'The experiment panel is turned off in Components.',
  'host.selection': 'Selection',
  'host.selection.off': 'The radar and the inspector are turned off in Components.',
  'host.status': 'Status',
  'host.status.summary': '{windows} windows · {mode} · {backend}',
  'host.backend': 'Presentation',
  'host.backend.dom': 'DOM',
  'host.backend.geometry': 'Geometry',
  'host.backend.none': 'none',
  'host.own.label': 'The host’s view controls',
  'host.own.heading': 'Facing',
  'host.own.fov': 'Width',
  'host.undo': 'Undo',
  'host.redo': 'Redo',
  'host.start.failed': 'The workspace could not start: {reason}',
  'host.view': 'Workspace',
} as const);

/** Every message the host page shows: the navigation controls' and its own. */
export const HOST_ENGLISH = Object.freeze({ ...NAVIGATION_ENGLISH, ...OWN });

/** A message the host page shows, by its ID. */
export type HostMessageId = keyof typeof HOST_ENGLISH;

/** The host page's messages in English. */
export function hostMessages(): Messages<HostMessageId> {
  return createMessages<HostMessageId>(HOST_ENGLISH);
}
