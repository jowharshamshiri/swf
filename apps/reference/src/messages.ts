/**
 * Every string the reference application shows, by a stable message ID. The application ships
 * English; a host may supply a translation pack for another locale. Messages take named
 * parameters (`{name}`), and numbers are formatted for the locale only when shown: the scene
 * itself always holds plain numbers in world units.
 */

export const ENGLISH = Object.freeze({
  'app.title': 'Spatial Workspace Framework',
  'mode.panorama': 'Panorama',
  'backend.dom': 'DOM',
  'backend.geometry': 'Geometry',
  'preset.empty': 'Empty',
  'preset.sparse': 'Sparse',
  'preset.dense': 'Dense',
  'preset.seam': 'Seam and behind the camera',
  'command.preset.load': 'Load preset',
  'command.scene.reset': 'Reset scene',
  'command.scene.reseed': 'Reseed scene',
  'command.mode.switch': 'Switch mode',
  'command.backend.switch': 'Switch backend',
  'empty.title': 'No windows yet',
  'empty.body':
    'Windows are placed around you in the panorama. Load a preset to add demo windows, or attach a surface through the workspace API.',
  'scene.summary': '{preset} scene, seed {seed}: {windows} windows',
  'content.note.body': 'A native page element: select and type here.',
  'content.tile.caption': 'Drawn content',
  'error.config': 'The address names an invalid {field}: {reason}',
} as const);

export type MessageId = keyof typeof ENGLISH;

/** A translation pack: any messages it has replace the English ones. */
export type MessagePack = Readonly<Partial<Record<MessageId, string>>>;

export type MessageParams = Readonly<Record<string, string | number>>;

export interface Messages {
  readonly locale: string;
  /** The message with its parameters filled in; numbers formatted for the locale. */
  format(id: MessageId, params?: MessageParams): string;
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
