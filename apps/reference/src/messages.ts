/**
 * Every string the reference application shows, by a stable message ID. The application ships
 * English; a host may supply a translation pack for another locale. Messages take named
 * parameters (`{name}`), and numbers are formatted for the locale only when shown: the scene
 * itself always holds plain numbers in world units.
 */

export const ENGLISH = Object.freeze({
  'app.title': 'Spatial Workspace Framework',
  'mode.label': 'View mode',
  'mode.panorama': 'Panorama',
  'backend.label': 'Presentation backend',
  'backend.dom': 'DOM',
  'backend.geometry': 'Geometry',
  'preset.empty': 'Empty',
  'preset.sparse': 'Sparse',
  'preset.dense': 'Dense',
  'preset.seam': 'Seam and behind the camera',
  'command.preset.load': 'Load preset',
  'command.preset.load.named': 'Load the {preset} scene',
  'command.scene.reset': 'Reset scene',
  'command.scene.reseed': 'Reseed scene',
  'command.mode.switch': 'Switch mode',
  'command.mode.switch.named': 'Show the {mode} view',
  'command.backend.switch': 'Switch backend',
  'command.backend.switch.named': 'Present with the {backend} backend',
  'command.window.reveal': 'Go to window',
  'command.window.reveal.named': 'Go to {label}',
  'palette.open': 'Commands and windows',
  'palette.label': 'Run a command or go to a window',
  'palette.placeholder': 'Type a command or a window’s name',
  'palette.empty': 'Nothing matches',
  'palette.command': 'Command',
  'palette.window': 'Window',
  'toolbar.label': 'Workspace',
  'scene.title': 'Scene',
  'scene.preset': 'Preset',
  'scene.seed': 'Seed',
  'scene.seed.hint': 'The same seed always plans the same windows.',
  'scene.seed.invalid': 'A seed is a whole number from 0 to 4294967295.',
  'scene.summary': '{preset} scene, seed {seed}: {windows} windows',
  'view.label': 'The workspace, all the way round',
  'panel.label': 'Panel',
  'panel.toggle': 'Show or hide the panel',
  'panel.fold': 'Fold the panel',
  'panel.unfold': 'Open the panel',
  'windows.title': 'Windows',
  'view.takeover': 'Hold Alt to move a window by its content',
  'empty.title': 'No windows yet',
  'empty.body':
    'Windows are placed around you in the panorama. Load a preset to add demo windows, or attach a surface through the workspace API.',
  'empty.action': 'Load the sparse scene',
  'inspector.title': 'Selection',
  'inspector.none': 'Nothing selected',
  'inspector.none.detail':
    'Hold Alt and press a window, press its frame, or go to it from the command list.',
  'inspector.label': 'Selected window',
  'inspector.id': 'ID',
  'inspector.name': 'Name',
  'inspector.content': 'Content',
  'inspector.heading': 'Heading',
  'inspector.elevation': 'Elevation',
  'inspector.distance': 'Distance',
  'inspector.presentation': 'Shown as',
  'inspector.degrees': '{value}°',
  'inspector.units': '{value} units',
  'content.note': 'Native note',
  'content.tile': 'Drawn tile',
  'presentation.live': 'Its own content',
  'presentation.proxy': 'A proxy',
  'status.title': 'Status',
  'status.label': 'Presentation measures',
  'status.backend': 'Backend',
  'status.backend.none': 'None: presentation unavailable',
  'status.frame': 'Last frame',
  'status.frame.value': '{value} ms',
  'status.fragments': 'Fragments',
  'status.live': 'Live surfaces',
  'status.writes': 'Writes',
  'status.fallbacks': 'Fallbacks',
  'status.pending': 'No frame yet',
  'diagnostics.title': 'Diagnostics',
  'diagnostics.label': 'Diagnostics of the running presentation',
  'diagnostics.candidates': 'Candidates in view',
  'diagnostics.culled': 'Culled',
  'diagnostics.bound': 'Bound surfaces',
  'diagnostics.failed': 'Failed bindings',
  'diagnostics.subscriptions': 'Subscriptions held',
  'diagnostics.errors': 'Errors',
  'content.note.body': 'A native page element: select and type here.',
  'content.tile.caption': 'Drawn content',
  'error.config': 'The address names an invalid {field}: {reason}',
  'error.command': '{command} failed: {reason}',
  'error.start': 'The workspace could not start: {reason}',
} as const);

export type MessageId = keyof typeof ENGLISH;

/** A translation pack: any messages it has replace the English ones. */
export type MessagePack = Readonly<Partial<Record<MessageId, string>>>;

export type MessageParams = Readonly<Record<string, string | number>>;

export interface Messages {
  readonly locale: string;
  /** The message with its parameters filled in; numbers formatted for the locale. */
  format(id: MessageId, params?: MessageParams): string;
  /** A number as the locale writes it. */
  number(value: number): string;
}

const PARAM = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/**
 * The messages of a locale: the pack's where it has them, English otherwise. A pack naming an
 * unknown message, or a message that names a parameter it is not given, is an error.
 */
export function createMessages(locale = 'en', pack: MessagePack = {}): Messages {
  for (const id of Object.keys(pack)) {
    if (!Object.hasOwn(ENGLISH, id)) {
      throw new Error(`the translation pack names an unknown message "${id}"`);
    }
  }
  const numbers = new Intl.NumberFormat(locale);
  return Object.freeze({
    locale,
    number: (value: number) => numbers.format(value),
    format(id: MessageId, params: MessageParams = {}): string {
      const template = pack[id] ?? ENGLISH[id];
      return template.replace(PARAM, (_, name: string) => {
        if (!Object.hasOwn(params, name)) {
          throw new Error(`message "${id}" needs the parameter "${name}"`);
        }
        const value = params[name];
        return typeof value === 'number' ? numbers.format(value) : String(value);
      });
    },
  });
}
