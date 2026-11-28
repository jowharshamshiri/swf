import type { Id, NodeRecord } from '@swf/core';
import type { CommandOutcome } from '@swf/interaction';
import { KEYBOARD_HOLD_ID } from '@swf/interaction';
import type {
  CommandResult,
  Navigation,
  NavigationCommandId,
  NavigationCommandSpecs,
  NavigationStatus,
  PolicyStatus,
  Pose,
  SpaceStatus,
  ViewMode,
} from '@swf/navigation';
import {
  cameraHeading,
  experimentOf,
  orbitHeading,
  spaceStatus,
  VIEWPORT_ID,
} from '@swf/navigation';
import type { FrameMetrics, Representation } from '@swf/presentation';
import type { NavigationMessageId, NavigationMessages } from './messages.js';

/**
 * A small picture of what a binding key's content holds, as the host draws it for a compact view
 * (the focus strip's cards). `revision` changes with its pixels.
 */
export interface ContentPreview {
  /** The picture. */
  readonly source: CanvasImageSource;
  /** Its width, in its own pixels. */
  readonly width: number;
  /** Its height, in its own pixels. */
  readonly height: number;
  /** Changes whenever its pixels do. */
  readonly revision: number;
}

/**
 * What the host says of its content, which navigation never looks into: what a surface and a
 * window show, in the host's words, and a picture of a surface's content for the focus strip.
 */
export interface HostContent {
  /** What a surface shows, in the host's words, or null to name it by its adapter. */
  describe(surface: {
    /** The adapter it is bound through. */
    readonly adapterTypeId: string;
    /** Its binding key, or null while it has none. */
    readonly bindingKey: string | null;
  }): string | null;
  /** What a window shows, in the host's words, or null when the host says nothing of it. */
  kind(node: NodeRecord): string | null;
  /** A picture of the content a binding key binds, or null when there is none (yet). */
  preview(bindingKey: string): ContentPreview | null;
}

/** The selected window, as the inspector shows it: where it stands as the panorama shows it. */
export interface SelectedWindow extends Pose {
  /** The window's ID. */
  readonly id: string;
  /** Its label, or null for none. */
  readonly label: string | null;
  /** What it shows, in the host's words ({@link HostContent.kind}), or null. */
  readonly content: string | null;
  /**
   * How the panorama shows its content as of its last frame: live, drawn by the backend, or by a
   * stand-in.
   */
  readonly presentation: 'live' | 'drawn' | 'proxy';
  /** How the view represents it (by semantic depth), or null while it is not shown. */
  readonly representation: Representation | null;
  /** In front of the camera's heading, or behind it. */
  readonly side: 'front' | 'behind';
}

/** A command that was refused, as the controls say it. */
export interface Refusal {
  /** The command's ID. */
  readonly command: string;
  /** The field at fault. */
  readonly field: string;
  /** Why it was refused. */
  readonly message: string;
}

/** A window removed from the workspace, said until dismissed or undone (UX-011). */
export interface Removal {
  /** The windows removed. */
  readonly ids: readonly string[];
  /** The window's name, or how many windows went. */
  readonly label: string;
  /** The transaction that removed it: undo is offered while it is the last undoable one. */
  readonly transactionId: string;
}

/**
 * What a quick action did, said over the panorama until dismissed, until a gesture or another
 * action, or until undo would no longer take it back.
 */
export interface Outcome {
  /** What it did, in words. */
  readonly text: string;
  /**
   * The change it made, while undo would take back that change and nothing later: null for an
   * action that changed nothing undoable (turning the view), or once a later change came first.
   */
  readonly transactionId: string | null;
  /** Rises with each outcome, so the same words said twice are said again. */
  readonly count: number;
}

/** A window, as a command list offers it. */
export interface WindowEntry {
  /** The window's ID. */
  readonly id: string;
  /** Its name: its label, or its ID. */
  readonly label: string;
}

/** Something said to assistive technology alone; `count` rises with each, so a repeat is said. */
export interface Announcement {
  /** What is said. */
  readonly text: string;
  /** Rises with each announcement. */
  readonly count: number;
}

/** The scene's groups and the readings that compare the camera with the workspace's turn. */
export interface OrbitScene {
  /** The scene's revision they were read at. */
  readonly revision: number;
  /** Every active group, as a choice of the group orbit turns. */
  readonly groups: readonly {
    /** The group's ID. */
    readonly value: string;
    /** Its name. */
    readonly label: string;
  }[];
  /** The designated group, or null. */
  readonly rootId: Id | null;
  /** The camera's heading, in degrees right of straight ahead. */
  readonly camera: number;
  /** The workspace's turn, in degrees, or null while no group is designated. */
  readonly turned: number | null;
}

/** Runs commands by ID: a navigation's, or a host's that holds them and its own. */
export interface CommandRunner<S> {
  /** Runs a command: what it did. */
  run<K extends keyof S & string>(id: K, params: S[K]): Promise<CommandResult>;
}

/** What the model is told of the host, besides the navigation it binds. */
export interface NavigationModelOptions {
  /** The messages the controls speak in. */
  readonly messages: NavigationMessages;
  /** What the host says of its content. */
  readonly content: HostContent;
  /**
   * Where each of the host's own commands' refusals is said, by command ID: a place a control of
   * the host's own reads with {@link NavigationModel.refusalAt}. A command named nowhere is said
   * over the panorama.
   */
  readonly places?: Readonly<Record<string, string>>;
}

/** The quick actions whose outcome is said, by the message that says it. */
const OUTCOMES = Object.freeze({
  'swf.window.bringFront': { message: 'outcome.bringFront', undoable: true },
  'swf.window.sendBehind': { message: 'outcome.sendBehind', undoable: true },
  'swf.window.arrange': { message: 'outcome.arrange', undoable: true },
  'swf.window.reveal': { message: 'outcome.reveal', undoable: false },
} as const);

/** What each framework operation a key runs is called, when it does nothing. */
const OPERATION_NAMES: Readonly<Record<string, NavigationMessageId>> = Object.freeze({
  'node.move': 'operation.node.move',
  'node.resize': 'operation.node.resize',
  'gesture.grab': 'operation.gesture.grab',
  'gesture.drop': 'operation.gesture.drop',
  'selection.next': 'operation.selection.next',
  'selection.previous': 'operation.selection.previous',
  'focus.selected': 'operation.focus.selected',
  'history.undo': 'operation.history.undo',
  'history.redo': 'operation.history.redo',
  'camera.turn': 'operation.camera.turn',
  'orbit.turn': 'operation.orbit.turn',
});

/** The commands that move a window, and what is said once each is done. */
const PLACING: Readonly<Partial<Record<string, 'moved'>>> = Object.freeze({
  'swf.window.place': 'moved',
  'swf.window.bringFront': 'moved',
  'swf.window.sendBehind': 'moved',
});

/**
 * Where each navigation command's refusal is said: the control that runs it. A command named
 * nowhere is said over the panorama.
 */
const PLACES: Readonly<Partial<Record<NavigationCommandId, string>>> = Object.freeze({
  'swf.experiment.run': 'experiments',
  'swf.feature.set': 'experiments',
  'swf.feature.reset': 'experiments',
  'swf.snap.configure': 'experiments',
  'swf.depth.configure': 'experiments',
  'swf.navigation.set': 'experiments',
  'swf.orbit.designate': 'experiments',
  'swf.orbit.turn': 'experiments',
  'swf.window.pose': 'inspector',
  'swf.window.lock': 'inspector',
  'swf.gesture.grab': 'inspector',
  'swf.gesture.drop': 'inspector',
  'swf.window.remove': 'inspector',
  'swf.surface.detach': 'inspector',
  'swf.surface.move': 'inspector',
  'swf.window.merge': 'inspector',
  'swf.window.split': 'inspector',
  'swf.window.recombine': 'inspector',
  'swf.window.regroup': 'inspector',
  'swf.window.group': 'inspector',
  'swf.window.bringFront': 'inspector',
  'swf.window.sendBehind': 'inspector',
  'swf.window.arrange': 'radar',
  'swf.view.fov': 'view',
  'swf.view.heading': 'view',
  'swf.orbit.turnTo': 'view',
});

/** The place a refusal is said when no control claims its command: over the panorama. */
export const PANORAMA_PLACE = 'panorama';

/** The announcements that say what a window is now, by its label and where it is. */
export type WindowAnnouncement =
  | 'announce.selected'
  | 'announce.moved'
  | 'announce.resized'
  | 'announce.held'
  | 'announce.preview'
  | 'announce.dropped';

/**
 * The navigation controls' binding to a navigation: its state as reactive values the controls
 * read, and its commands as the one way they change anything. Every control takes this model and
 * nothing else, so each can be left out, styled or replaced on its own; a host's control of its own
 * reads the same values and runs the same commands. The model binds a navigation the host made
 * ({@link attach}), never makes or disposes one, and its commands may be a host's that hold
 * navigation's and its own (`S`), whose refusals it says where {@link NavigationModelOptions.places}
 * puts them.
 */
export class NavigationModel<S extends NavigationCommandSpecs = NavigationCommandSpecs> {
  /** What navigation shows, once a navigation is attached. */
  status = $state<NavigationStatus | null>(null);
  /** The window inspected: the first selected. */
  selected = $state<SelectedWindow | null>(null);
  /** Every window selected, the one inspected first. */
  selection = $state<readonly string[]>([]);
  /** The window focused, or null. */
  focusedId = $state<string | null>(null);
  /** The panorama's width, in CSS pixels, or null before a navigation is attached. */
  viewWidth = $state<number | null>(null);
  /** The panorama's last frame's measures. */
  frame = $state<FrameMetrics | null>(null);
  /** How many fragments of the last frame fell back to a lesser presentation. */
  fallbacks = $state(0);
  /** The workspace as the panorama's last frame shows it, in the reader's terms. */
  space = $state<SpaceStatus | null>(null);
  /** What the last quick action did, while it is said. */
  outcome = $state<Outcome | null>(null);
  /** The last command refused, until the next one runs. */
  refusal = $state<Refusal | null>(null);
  /** The scene's revision, read again on every commit: what views of the scene follow. */
  revision = $state(0);
  /** Rises whenever the search's query or results change. */
  searchVersion = $state(0);
  /** Rises each time a window is asked to be inspected: a host opens its inspector. */
  inspections = $state(0);
  /** The capabilities: which are on, their settings, the gesture running and the last one. */
  policies = $state<PolicyStatus | null>(null);
  /**
   * The view modes offered, in the switcher's order: read again whenever the policies change,
   * since the focus and map capabilities register theirs while they are on.
   */
  modes = $state.raw<readonly ViewMode[]>([]);
  /**
   * The experiment the capabilities' switches are now, or null for a custom combination (and
   * before a navigation is attached).
   */
  experiment = $derived(
    this.policies === null ? null : experimentOf(this.policies.features.enabled),
  );
  /**
   * The groups workspace rotation can turn, the one designated, and the readings that compare the
   * camera and the workspace, read again at each of the scene's revisions. Null before a
   * navigation is attached.
   */
  orbitScene = $derived.by((): OrbitScene | null => {
    const revision = this.revision;
    const navigation = this.navigation;
    if (navigation === null) {
      return null;
    }
    const state = navigation.workspace.getState();
    const groups = [...state.nodes.values()]
      .filter((node) => node.kind === 'group' && node.status === 'active')
      .map((node) => ({ value: node.id, label: node.label ?? node.id }));
    const turned = orbitHeading(state);
    return {
      revision,
      groups,
      // Read with the groups, from the same scene, so the chosen one is always among them.
      rootId: state.orbitRootId,
      camera: (cameraHeading(state, VIEWPORT_ID) * 180) / Math.PI,
      turned: turned === null ? null : (turned * 180) / Math.PI,
    };
  });
  /** Whether there is something to undo and to redo. */
  history = $state({ undo: false, redo: false });
  /** The window the map was last asked to show, and how many times it has been asked. */
  mapRequest = $state<{ readonly id: string; readonly count: number } | null>(null);
  /** The last window removed, while it can be undone. */
  removal = $state<Removal | null>(null);
  /** The last thing said to assistive technology alone (UX-013). */
  announcement = $state<Announcement | null>(null);
  /** Why the last key pressed in the panorama did nothing, until a key next does something. */
  keyRefusal = $state<string | null>(null);
  /** Whether the panorama itself has the keyboard (not a window's content in it). */
  panoramaFocused = $state(false);
  /** The window whose live content has the keyboard, or null while none's has. */
  contentFocused = $state<string | null>(null);

  /** The messages the controls speak in. */
  readonly messages: NavigationMessages;
  /** What the host says of its content. */
  readonly content: HostContent;
  readonly #places: Readonly<Record<string, string>>;
  #navigation = $state.raw<Navigation | null>(null);
  #commands: CommandRunner<S> | null = null;
  #names: Readonly<Record<string, string>> = {};
  #stops: (() => void)[] = [];
  /** The gesture holding a window from the keyboard, and the window, while one does. */
  #held: { readonly gestureId: string; readonly nodeId: string | null } | null = null;

  constructor(options: NavigationModelOptions) {
    this.messages = options.messages;
    this.content = options.content;
    this.#places = options.places ?? {};
  }

  /** The navigation the controls work through; null until one is attached. */
  get navigation(): Navigation | null {
    return this.#navigation;
  }

  /**
   * Binds a navigation the host made, with the commands the controls run (navigation's, or a
   * host's that hold them) and the message naming each, for its refusals. Throws an Error when a
   * navigation is attached already: a model binds one navigation for its life.
   */
  attach(
    navigation: Navigation,
    commands: CommandRunner<S>,
    names: Readonly<Record<keyof S & string, string>>,
  ): void {
    if (this.#navigation !== null) {
      throw new Error('a navigation is attached already: a model binds one for its life');
    }
    this.#navigation = navigation;
    this.#commands = commands;
    this.#names = names;
    this.status = navigation.status();
    this.policies = navigation.policies.status();
    this.modes = navigation.modes.list();
    this.#readSelection();
    this.#readHistory();
    this.#stops.push(
      navigation.policies.subscribe(() => {
        this.policies = navigation.policies.status();
        // The focus and map capabilities register their modes while they are on.
        this.modes = navigation.modes.list();
      }),
      navigation.subscribe((status) => {
        this.status = status;
      }),
      navigation.workspace.subscribe((event) => {
        if (event.type === 'transaction.committed') {
          this.revision = navigation.workspace.getState().revision;
          this.#readSelection();
          this.#readHistory();
          const last = navigation.workspace.history().at(-1)?.transactionId;
          // Undo would no longer take the last quick action back: a later change came first.
          if (
            this.outcome !== null &&
            this.outcome.transactionId !== null &&
            last !== this.outcome.transactionId
          ) {
            this.outcome = { ...this.outcome, transactionId: null };
          }
          // Undo would no longer bring the removed window back: a later change came first.
          if (this.removal !== null && last !== this.removal.transactionId) {
            this.removal = null;
          }
        }
      }),
      navigation.search.subscribe(() => {
        this.searchVersion += 1;
      }),
      navigation.observeInput(({ intent, result }) => {
        const operation = result.operation;
        if (intent.kind === 'key' && operation !== null && 'status' in operation.outcome) {
          this.#keyed(operation.name, operation.outcome);
        }
      }),
      navigation.router.subscribe((event) => {
        if (event.type === 'gesture.started') {
          // A gesture is the reader's next action: the last quick action's outcome is no longer said.
          this.outcome = null;
        }
        if (event.type === 'gesture.started' && event.policyId === KEYBOARD_HOLD_ID) {
          this.#held = { gestureId: event.gestureId, nodeId: event.nodeId };
          this.say('announce.held', event.nodeId);
        } else if (event.type === 'gesture.ended' && event.gestureId === this.#held?.gestureId) {
          const nodeId = this.#held.nodeId;
          this.#held = null;
          if (event.finish.outcome === 'cancelled') {
            this.announce(
              this.messages.format('announce.cancelled', { label: this.labelOf(nodeId) }),
            );
          } else {
            this.say('announce.dropped', nodeId);
          }
        }
      }),
      navigation.presenter.subscribe((event) => {
        if (event.type === 'frame' && event.viewportId === VIEWPORT_ID) {
          this.frame = event.metrics;
          this.fallbacks = event.fallbacks.length;
          const presented = navigation.viewport.lastFrame();
          this.space =
            presented === null ? null : spaceStatus(presented.frame, navigation.windows.partOfKey);
          this.#readSelection();
        }
      }),
    );
  }

  /** Runs a command; a refusal is kept to be said. False when it was refused, or none is attached. */
  async run<K extends keyof S & string>(id: K, params: S[K]): Promise<boolean> {
    const commands = this.#commands;
    if (commands === null) {
      return false;
    }
    this.refusal = null;
    const outcome = await commands.run(id, params);
    if (outcome.status === 'rejected') {
      this.refusal = { command: id, field: outcome.field, message: outcome.message };
      return false;
    }
    this.ran(id, params);
    return true;
  }

  /** Runs one of navigation's own commands, through the runner attached. */
  runNavigation<K extends NavigationCommandId>(
    id: K,
    params: NavigationCommandSpecs[K],
  ): Promise<boolean> {
    return this.run(id, params as unknown as S[keyof S & string]);
  }

  /** Stops saying the last quick action's outcome. */
  dismissOutcome(): void {
    this.outcome = null;
  }

  /** Gives the panorama the keyboard; false while there is none to give it to. */
  focusPanorama(): boolean {
    const root = this.#navigation?.root;
    if (root === undefined) {
      return false;
    }
    root.focus();
    return true;
  }

  /** Says a text to assistive technology alone, politely, after what it is reading. */
  announce(text: string): void {
    this.announcement = { text, count: (this.announcement?.count ?? 0) + 1 };
  }

  /** A window's name: its label, or its ID; empty for none. */
  labelOf(id: string | null): string {
    const node = id === null ? undefined : this.#navigation?.workspace.getState().nodes.get(id);
    return node?.label ?? id ?? '';
  }

  /** Where a window stands, in words. */
  where(pose: Pose): string {
    const t = this.messages;
    const round = (value: number, digits = 0) => Number(Math.abs(value).toFixed(digits));
    return t.format('where.text', {
      heading: round(pose.heading),
      side: t.format(pose.heading < 0 ? 'where.left' : 'where.right'),
      distance: round(pose.reach, 2),
      height: round(pose.above, 2),
      updown: t.format(pose.above < 0 ? 'where.down' : 'where.up'),
    });
  }

  /** Says what a window is now, by a message that names its label and where it is. */
  say(id: WindowAnnouncement | 'announce.added', nodeId: string | null): void {
    const pose = nodeId === null ? null : (this.#navigation?.poseOf(nodeId) ?? null);
    if (pose === null) {
      return;
    }
    const round = (value: number, digits: number) => Number(value.toFixed(digits));
    this.announce(
      this.messages.named(id, {
        label: this.labelOf(nodeId),
        where: this.where(pose),
        width: round(pose.width, 2),
        height: round(pose.height, 2),
      }),
    );
  }

  /** What a key pressed in the panorama did: said, or why it did nothing shown. */
  #keyed(name: string, outcome: CommandOutcome): void {
    switch (outcome.status) {
      case 'rejected':
      case 'unchanged':
        this.keyRefusal = this.messages.format('keys.refused', {
          operation: this.messages.format(OPERATION_NAMES[name] ?? 'operation.other'),
          reason:
            outcome.status === 'unchanged'
              ? outcome.reason
              : outcome.error.code === 'LOCKED'
                ? this.messages.format('keys.locked', {
                    label: this.labelOf(outcome.error.entityId ?? this.selected?.id ?? null),
                  })
                : outcome.error.message,
        });
        return;
      case 'cancelled':
        this.keyRefusal = null;
        return;
      case 'previewed':
        this.keyRefusal = null;
        // Picking up is said when the hold starts; each change while held says where it would go.
        if (name !== 'gesture.grab') {
          this.say('announce.preview', this.#held?.nodeId ?? null);
        }
        return;
      case 'committed': {
        this.keyRefusal = null;
        const selected = this.#navigation?.workspace.getState().selection[0] ?? null;
        switch (name) {
          case 'node.move':
            this.say('announce.moved', selected);
            return;
          case 'node.resize':
            this.say('announce.resized', selected);
            return;
          case 'selection.next':
          case 'selection.previous':
            this.say('announce.selected', selected);
            return;
          case 'history.undo':
            this.announce(this.messages.format('announce.undone'));
            return;
          case 'history.redo':
            this.announce(this.messages.format('announce.redone'));
            return;
          default:
            return;
        }
      }
    }
  }

  /**
   * What a command run did, said where nothing on screen says it (UX-013). A host's model that
   * runs commands of its own says theirs by overriding this, and hands navigation's on to it.
   */
  protected ran(id: string, params: unknown): void {
    const windowId =
      typeof params === 'object' &&
      params !== null &&
      'id' in params &&
      typeof params.id === 'string'
        ? params.id
        : null;
    const said = Object.hasOwn(OUTCOMES, id) ? OUTCOMES[id as keyof typeof OUTCOMES] : null;
    if (said !== null) {
      const text = this.messages.format(said.message, { label: this.labelOf(windowId) });
      this.outcome = {
        text,
        transactionId: said.undoable
          ? (this.#navigation?.workspace.history().at(-1)?.transactionId ?? null)
          : null,
        count: (this.outcome?.count ?? 0) + 1,
      };
      this.announce(text);
      return;
    }
    if (PLACING[id] !== undefined) {
      // A held window's change is said as the hold's preview.
      this.say(this.#held !== null ? 'announce.preview' : 'announce.moved', windowId);
      return;
    }
    switch (id) {
      case 'swf.window.pose': {
        // A pose shown while a control moves is said by the control; the change made, once.
        const pose = params as NavigationCommandSpecs['swf.window.pose'];
        if (pose.preview === true) {
          return;
        }
        this.say(
          this.#held !== null
            ? 'announce.preview'
            : pose.heading !== undefined || pose.reach !== undefined || pose.y !== undefined
              ? 'announce.moved'
              : 'announce.resized',
          windowId,
        );
        return;
      }
      case 'swf.window.lock':
        this.announce(
          this.messages.format(
            (params as NavigationCommandSpecs['swf.window.lock']).locked
              ? 'announce.locked'
              : 'announce.unlocked',
            { label: this.labelOf(windowId) },
          ),
        );
        return;
      case 'swf.history.undo':
        this.announce(this.messages.format('announce.undone'));
        return;
      case 'swf.history.redo':
        this.announce(this.messages.format('announce.redone'));
        return;
      default:
        return;
    }
  }

  /**
   * Where a refusal is said: the control that runs its command (`radar`, `view`, `inspector`,
   * `experiments`), a place the host named for its own, or {@link PANORAMA_PLACE}.
   */
  placeOf(refusal: Refusal): string {
    return (
      PLACES[refusal.command as NavigationCommandId] ??
      this.#places[refusal.command] ??
      PANORAMA_PLACE
    );
  }

  /** The refusal said at a place, or null while none is. */
  refusalAt(place: string): Refusal | null {
    const refusal = this.refusal;
    return refusal !== null && this.placeOf(refusal) === place ? refusal : null;
  }

  /** The refusal, said in words. */
  refusalText(refusal: Refusal): string {
    const name = this.#names[refusal.command];
    return this.messages.format('error.command', {
      command: name === undefined ? refusal.command : this.messages.named(name),
      reason: refusal.message,
    });
  }

  /**
   * Removes windows from the workspace (UX-011): one undoable change, said with an undo until it
   * is dismissed or something else changes.
   */
  async removeWindows(ids: readonly string[]): Promise<boolean> {
    const only = ids.length === 1 ? ids[0] : undefined;
    const label =
      only === undefined
        ? this.messages.format('removed.windows', { count: ids.length })
        : this.labelOf(only);
    const done = await this.runNavigation('swf.window.remove', { ids });
    if (done) {
      const last = this.#navigation?.workspace.history().at(-1);
      this.removal = last === undefined ? null : { ids, label, transactionId: last.transactionId };
    }
    return done;
  }

  /** Undoes the removal said, while it is still the last change. */
  async undoRemoval(): Promise<boolean> {
    this.removal = null;
    return this.runNavigation('swf.history.undo', {});
  }

  /** Stops saying the last removal. */
  dismissRemoval(): void {
    this.removal = null;
  }

  /** Selects a window, as pressing it in a list or on the map does: nothing else changes. */
  async select(id: string): Promise<boolean> {
    return this.runNavigation('swf.window.inspect', { id });
  }

  /** Selects a window and asks for the inspector on it ({@link inspections}). */
  async inspect(id: string): Promise<boolean> {
    const done = await this.runNavigation('swf.window.inspect', { id });
    if (done) {
      this.inspections += 1;
    }
    return done;
  }

  /** Selects a window, shows the map, and centres the map on it. */
  async showInMap(id: string): Promise<boolean> {
    const done = await this.runNavigation('swf.window.map', { id });
    if (done) {
      this.mapRequest = { id, count: (this.mapRequest?.count ?? 0) + 1 };
    }
    return done;
  }

  /** Every window, in ID order, by its label. */
  windows(): WindowEntry[] {
    const navigation = this.#navigation;
    if (navigation === null) {
      return [];
    }
    return [...navigation.workspace.getState().nodes.values()]
      .filter((node) => node.kind === 'window' && node.status === 'active')
      .map((node) => ({ id: node.id, label: node.label ?? node.id }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Stops following the navigation; the navigation itself is the host's to dispose. The model
   * then shows nothing and runs nothing.
   */
  detach(): void {
    for (const stop of this.#stops.splice(0)) {
      stop();
    }
    this.#navigation = null;
    this.#commands = null;
  }

  #readHistory(): void {
    const navigation = this.#navigation;
    if (navigation === null) {
      return;
    }
    const undo = navigation.workspace.canUndo();
    const redo = navigation.workspace.canRedo();
    if (undo !== this.history.undo || redo !== this.history.redo) {
      this.history = { undo, redo };
    }
  }

  #readSelection(): void {
    const navigation = this.#navigation;
    if (navigation === null) {
      return;
    }
    const state = navigation.workspace.getState();
    if (
      state.selection.length !== this.selection.length ||
      state.selection.some((id, i) => id !== this.selection[i])
    ) {
      this.selection = state.selection;
    }
    this.focusedId = state.focusedId;
    this.viewWidth = state.viewports.get(VIEWPORT_ID)?.size.width ?? null;
    const id = state.selection[0];
    const node = id === undefined ? undefined : state.nodes.get(id);
    if (node === undefined) {
      this.selected = null;
      return;
    }
    // Where it stands as the panorama shows it, whatever group it is in and however that group
    // is turned, a held window where it is held.
    const pose = navigation.poseOf(node.id);
    if (pose === null) {
      this.selected = null;
      return;
    }
    const surfaceId = node.surfaceIds[0];
    const next: SelectedWindow = {
      ...pose,
      id: node.id,
      label: node.label,
      content: this.content.kind(node),
      presentation:
        surfaceId === undefined
          ? 'proxy'
          : navigation.viewport.presentation(surfaceId) === 'live'
            ? 'live'
            : (navigation.viewport.lastFrame()?.frame.planned ?? []).some(
                  (p) =>
                    p.fragment.surfaceId === surfaceId && p.negotiation.layer === 'content-raster',
                )
              ? 'drawn'
              : 'proxy',
      representation: navigation.policies.representationOf(node.id),
      side:
        Math.cos(
          pose.heading * (Math.PI / 180) -
            cameraHeading(navigation.workspace.getPresented(), VIEWPORT_ID),
        ) >= 0
          ? 'front'
          : 'behind',
    };
    const last = this.selected;
    if (
      last === null ||
      (Object.keys(next) as (keyof SelectedWindow)[]).some(
        (key) => key !== 'position' && last[key] !== next[key],
      ) ||
      next.position.some((value, i) => value !== last.position[i])
    ) {
      this.selected = next;
    }
  }
}
