import type { BackendId, Navigation } from '@swf/navigation';
import { createNavigation, createNavigationCommands } from '@swf/navigation';
import {
  KIT_CHROME,
  NAVIGATION_COMMAND_NAMES,
  NavigationModel,
  navigationWords,
} from '@swf/navigation-ui';
import type { HostViews } from './content.js';
import { createHostViews, openingCommands } from './content.js';
import type { HostMessageId } from './messages.js';
import { hostMessages } from './messages.js';

/** The field of view the host opens with, in degrees. */
export const OPENING_FIELD_OF_VIEW = 160;

/** The navigation controls the host shows, each on or off on its own. */
export interface Components {
  switcher: boolean;
  radar: boolean;
  inspector: boolean;
  controls: 'package' | 'own' | 'none';
  strip: boolean;
  map: boolean;
  overview: boolean;
  experiments: boolean;
}

/**
 * THE HOST: its own content, the framework's navigation over it, and the navigation controls'
 * model. It makes the navigation in the element the panorama hands it, with its own adapters, opens
 * its views round the reader, and attaches the navigation to the controls' model with
 * navigation's own commands. Which controls are shown is the host's choice, made in `components`.
 */
export class Host {
  /** Which controls are shown, as the host's Components view sets them. */
  components = $state<Components>({
    switcher: true,
    radar: true,
    inspector: true,
    controls: 'package',
    strip: true,
    map: true,
    overview: true,
    experiments: true,
  });
  /** Why the workspace could not start, or null. */
  problem = $state<string | null>(null);

  readonly messages = hostMessages();
  readonly views: HostViews;
  readonly model: NavigationModel;
  readonly #backend: BackendId;
  #navigation: Navigation | null = null;
  #stop: (() => void) | null = null;
  readonly #started: Promise<void>;
  #settle: () => void = () => undefined;

  constructor(document: Document, backend: BackendId = 'geometry') {
    this.views = createHostViews(document);
    this.model = new NavigationModel({ messages: this.messages, content: this.views.content });
    this.#backend = backend;
    this.#started = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  /** Settles once the navigation has started, or could not ({@link problem}). */
  started(): Promise<void> {
    return this.#started;
  }

  /** A message of the host page's. */
  readonly t = (id: HostMessageId, params?: Readonly<Record<string, string | number>>): string =>
    this.messages.format(id, params);

  /** The navigation, once it has started. */
  get navigation(): Navigation | null {
    return this.#navigation;
  }

  /** Makes the navigation in the panorama's surface, opens the host's views, and attaches it. */
  async start(surface: HTMLElement): Promise<void> {
    if (this.#navigation !== null) {
      throw new Error('the host starts its navigation once');
    }
    try {
      const navigation = await createNavigation({
        root: surface,
        id: 'host',
        adapters: this.views.adapters,
        windows: this.views.windows,
        backend: this.#backend,
        chrome: KIT_CHROME,
        words: navigationWords(this.messages),
      });
      const opened = navigation.workspace.transaction(openingCommands(), { source: 'system' });
      if (opened.status !== 'committed') {
        await navigation.dispose();
        throw new Error(`the host's views could not be opened: ${JSON.stringify(opened)}`);
      }
      // The host opens on the views round the reader, wide enough to read: the whole circle is
      // a turn of the view's width away.
      const widened = navigation.modes.fieldOfView(OPENING_FIELD_OF_VIEW);
      if (widened.status !== 'committed') {
        await navigation.dispose();
        throw new Error(`the host's view could not be set: ${JSON.stringify(widened)}`);
      }
      this.#navigation = navigation;
      this.model.attach(
        navigation,
        createNavigationCommands(() => navigation),
        NAVIGATION_COMMAND_NAMES,
      );
      // What runs by itself redraws: the presented view is asked for a frame.
      this.#stop = this.views.run(() => {
        navigation.viewport.invalidate();
      });
    } catch (error) {
      this.problem = this.t('host.start.failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#settle();
    }
  }

  /** Stops the host's content and its navigation, giving its elements back. */
  async dispose(): Promise<void> {
    this.#stop?.();
    this.#stop = null;
    this.model.detach();
    const navigation = this.#navigation;
    this.#navigation = null;
    await navigation?.dispose();
  }
}
