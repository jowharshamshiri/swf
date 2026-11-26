<script lang="ts">
  // THE REFERENCE APPLICATION'S WINDOW, as the kit lays a window out: the scene and the list of
  // windows on the left, what is selected on the right, the panorama as the whole centre with
  // the view's commands across its top, and how it is presented in the panel below. A narrow
  // window floats one side at a time over the panorama, so nothing is lost.
  import {
    announce,
    Announcer,
    Badge,
    IconButton,
    Segmented,
    Select,
    Stack,
    StatusItem,
    Tabs,
  } from '@wsb/uikit/components';
  import { FOCUS_ID, MAP, OVERVIEW, VIEWPORT_ID } from '@swf/navigation';
  import { handleOf } from '@wsb/uikit/handles';
  import { Application } from '@wsb/uikit/surfaces/application';
  import type { MessageId } from '../messages.js';
  import { PRESETS } from '../presets.js';
  import type { Component } from 'svelte';
  import { untrack } from 'svelte';
  import InspectorView from './InspectorView.svelte';
  import RadarView from './RadarView.svelte';
  import type { ShellModel } from './model.svelte.js';
  import Palette from './Palette.svelte';
  import CentreView from './CentreView.svelte';
  import SceneView from './SceneView.svelte';
  import ScenariosView from './ScenariosView.svelte';
  import StatusBody from './StatusBody.svelte';
  import WindowsView from './WindowsView.svelte';
  import WorkspacesView from './WorkspacesView.svelte';
  import ReplaceDialog from './ReplaceDialog.svelte';

  interface Props {
    model: ShellModel;
    /**
     * The debug overlay's view, in staging builds and development; production builds have none,
     * and carry nothing of it.
     */
    developer?: Component<{ model: ShellModel }> | null;
    /**
     * The experiment panel, where the build carries it; a build without it has every capability
     * on, with the everyday controls (the view's switcher and sliders, the radar, the command list)
     * as they are.
     */
    experiments?: Component<{ model: ShellModel }> | null;
  }

  let { model, developer = null, experiments = null }: Props = $props();
  /** Inputs that are pressed or chosen, not typed in. */
  const NOT_TYPED = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'];
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  let leftView = $state<string | null>('scene');
  let rightView = $state<string | null>('inspector');
  /** The radar is open above the inspector: folded, it leaves the inspector the whole side. */
  let radarOpen = $state(true);
  let widths = $state({ left: 280, right: 280 });
  let panelOpen = $state(true);
  let panelHeight = $state(190);
  let paletteOpen = $state(false);

  /**
   * The application's keys, wherever the keyboard is but in a field or a window's own content,
   * which keep their own (UX-012). As VS Code: Ctrl+Shift+P or F1 opens the command list; Ctrl+Z
   * undoes, Ctrl+Shift+Z or Ctrl+Y redoes; Ctrl+S saves now (Cmd on a Mac). Escape cancels a
   * gesture running, or else closes the focus, as it leaves VS Code's zen mode, unless something
   * else took it first. In the panorama the framework's keys act first.
   */
  function onkeydown(event: KeyboardEvent): void {
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const palette = event.key === 'F1' || (command && event.shiftKey && key === 'p');
    if (palette && model.app !== null) {
      event.preventDefault();
      paletteOpen = true;
      return;
    }
    const target = event.target;
    // A field that takes typing keeps its own keys (its own undo among them), as whatever has the
    // keyboard in a window's live content does (in the slot the host's content is attached to,
    // whichever backend presents it); a checkbox, a choice or a button elsewhere takes none.
    const typing =
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        (target instanceof HTMLInputElement && !NOT_TYPED.includes(target.type)) ||
        target.closest('textarea, select, [data-swf-slot]') !== null);
    if (event.defaultPrevented || paletteOpen || typing || model.app === null) {
      return;
    }
    if (command && !event.altKey) {
      const undo = key === 'z' && !event.shiftKey;
      const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey);
      if (undo || redo) {
        event.preventDefault();
        void model.run(undo ? 'swf.history.undo' : 'swf.history.redo', {});
        return;
      }
      if (key === 's' && !event.shiftKey) {
        event.preventDefault();
        void model.run('reference.workspace.saveNow', {});
        return;
      }
    }
    if (event.key === 'Escape' && model.policies?.gesture != null) {
      event.preventDefault();
      void model.run('swf.gesture.cancel', {});
      return;
    }
    if (event.key === 'Escape' && model.status?.mode === FOCUS_ID) {
      event.preventDefault();
      void model.run('swf.focus.exit', {});
      return;
    }
    if (event.target === model.app.root && !command && !event.altKey) {
      panoramaKey(event);
    }
  }

  /**
   * The panorama's own keys for its views, while the panorama has the keyboard (so a single key
   * never acts from anywhere else, WCAG 2.1.4): 1 to 4 show the views in the switcher's order, F
   * focuses the selected window, M shows the map, Delete or Backspace removes the selected windows
   * (one change, with an undo offered), and Escape leaves the map or the overview for the view it
   * was opened from.
   */
  function panoramaKey(event: KeyboardEvent): void {
    const listed = modes.filter((mode) => !mode.disabled);
    const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : null;
    if (digit !== null) {
      const mode = modes[digit - 1];
      if (mode !== undefined && listed.includes(mode)) {
        event.preventDefault();
        void model.run('swf.mode.switch', { mode: mode.value });
      }
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'f' && model.policies?.features.enabled.focus === true) {
      event.preventDefault();
      void model.run('swf.focus.enter', {});
      return;
    }
    if (key === 'm' && model.policies?.features.enabled.map === true) {
      event.preventDefault();
      void model.run('swf.mode.switch', { mode: MAP.id });
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // As a file explorer: Delete (or Backspace) removes what is selected, with an undo offered.
      const selection = model.selection;
      if (selection.length > 0) {
        event.preventDefault();
        void model.removeWindows(selection);
      }
      return;
    }
    if (event.key === 'Escape' && (model.status?.mode === MAP.id || model.status?.mode === OVERVIEW.id)) {
      event.preventDefault();
      void model.run('swf.mode.back', {});
    }
  }

  // What the application did that is not shown as text is said, each announcement once: it
  // follows the model's announcement alone, never the announcer's own lines.
  $effect(() => {
    const said = model.announcement;
    if (said !== null) {
      untrack(() => {
        announce(said.text);
      });
    }
  });

  // A window asked to be inspected: the inspector opens on it, as it does to say why a command
  // run on the selected window was refused.
  $effect(() => {
    if (model.inspections > 0) {
      rightView = 'inspector';
    }
  });
  $effect(() => {
    if (model.refusal !== null && model.isInspectorRefusal(model.refusal)) {
      rightView = 'inspector';
    }
  });
  // A scenario started from anywhere (the command list among them) shows its steps.
  $effect(() => {
    if (model.scenarioStarts > 0) {
      leftView = 'scenarios';
    }
  });

  const persisting = $derived(model.policies?.features.enabled.persistence ?? false);
  const saveStatus = $derived.by(() => {
    const status = model.workspaces;
    if (status === null || !persisting) {
      return null;
    }
    if (!status.autosave) {
      return t('save.off');
    }
    return status.save === 'failed'
      ? t('save.failed', { reason: status.saveError?.message ?? '' })
      : t(`save.${status.save}`);
  });
  const sideViews = (
    views: {
      id: string;
      icon: 'plans' | 'list' | 'info' | 'statistics' | 'settings' | 'folder' | 'tool' | 'resume';
      label: string;
    }[],
  ) => views;
  const leftViews = $derived(
    sideViews([
      { id: 'scene', icon: 'plans', label: t('scene.title') },
      { id: 'scenarios', icon: 'resume', label: t('scenarios.title') },
      { id: 'windows', icon: 'list', label: t('windows.title') },
      // Saving and opening workspaces is a feature: off, its view is taken away with it.
      ...(persisting ? [{ id: 'workspaces', icon: 'folder' as const, label: t('workspaces.title') }] : []),
      ...(experiments === null
        ? []
        : [{ id: 'experiments', icon: 'settings' as const, label: t('experiments.title') }]),
    ]),
  );
  // A view taken away while it was open leaves its side closed.
  $effect(() => {
    if (leftView === 'workspaces' && !persisting) {
      leftView = null;
    }
  });
  const rightViews = $derived(
    sideViews([
      { id: 'inspector', icon: 'info', label: t('side.right') },
      ...(developer === null
        ? []
        : [{ id: 'developer', icon: 'tool' as const, label: t('dev.title') }]),
    ]),
  );
  // Focus needs a window: offered once one is selected or focused, or while it is shown.
  const focusable = $derived.by(() => {
    void model.revision;
    return (
      model.selected !== null ||
      model.status?.mode === FOCUS_ID ||
      (model.app?.workspace.getState().focusedId ?? null) !== null
    );
  });
  const modes = $derived(
    model.modes.map((mode) => ({
      value: mode.id,
      label: model.messages.named(mode.name),
      disabled: mode.id === FOCUS_ID && !focusable,
    })),
  );
  const status = $derived(model.status);
  const policies = $derived(model.policies);
  /**
   * A centre too narrow for every action across its top (a phone, NFR-023): the mode is chosen
   * from a list, and what drags turn and the backend are left to the command list and the experiment panel,
   * so the actions stay within the centre.
   */
  const COMPACT_BELOW = 600;
  const compact = $derived.by(() => {
    void model.revision;
    const width = model.app?.workspace.getState().viewports.get(VIEWPORT_ID)?.size.width;
    return width !== undefined && width < COMPACT_BELOW;
  });
</script>

<svelte:window {onkeydown} />

{#snippet leftContent(view: string)}
  {#if view === 'scene'}
    <SceneView {model} />
  {:else if view === 'scenarios'}
    <ScenariosView {model} />
  {:else if view === 'windows'}
    <WindowsView {model} />
  {:else if experiments !== null && view === 'experiments'}
    {@const Experiments = experiments}
    <Experiments {model} />
  {:else if view === 'workspaces' && persisting}
    <WorkspacesView {model} />
  {/if}
{/snippet}

{#snippet rightContent(view: string)}
  {#if view === 'inspector'}
    <!-- The radar first, then what is selected: the two share the side's height. -->
    <Stack fill gap="small">
      <RadarView
        {model}
        open={radarOpen}
        ontoggle={(open) => {
          radarOpen = open;
        }}
      />
      <Stack grow>
        <InspectorView {model} />
      </Stack>
    </Stack>
  {:else if developer !== null && view === 'developer'}
    {@const Developer = developer}
    <Developer {model} />
  {/if}
{/snippet}

{#snippet centreView()}
  <CentreView {model} />
{/snippet}

{#snippet editorActions()}
  {#if status !== null && modes.length === 1}
    <!-- One mode is not a choice: it is said, and becomes a switcher once a second registers. -->
    <Badge handle={handleOf`editor.actions.mode`} label={modes[0]?.label ?? status.mode} title={t('mode.label')} />
  {:else if status !== null && modes.length > 1 && compact}
    <Select
      handle={handleOf`editor.actions.mode`}
      id="reference-mode"
      ariaLabel={t('mode.label')}
      options={modes.map((mode) => ({ value: mode.value, label: mode.label, disabled: mode.disabled }))}
      value={status.mode}
      onchange={(mode) => {
        void model.run('swf.mode.switch', { mode });
      }}
    />
  {:else if status !== null && modes.length > 1}
    <Segmented
      handle={handleOf`editor.actions.mode`}
      ariaLabel={t('mode.label')}
      items={modes}
      selected={status.mode}
      onselect={(mode) => {
        void model.run('swf.mode.switch', { mode });
      }}
    />
  {/if}
  {#if policies !== null && policies.features.enabled.orbit && !compact}
    <!-- What a background drag turns is said where the view is, and changed there. -->
    <Segmented
      handle={handleOf`editor.actions.navigation`}
      ariaLabel={t('orbit.navigation')}
      items={[
        { value: 'camera', label: t('orbit.navigation.camera'), title: t('command.navigation.camera') },
        {
          value: 'orbit',
          label: t('orbit.navigation.orbit'),
          disabled: policies.orbit.rootId === null,
          title:
            policies.orbit.rootId === null
              ? t('orbit.navigation.noroot')
              : t('command.navigation.orbit'),
        },
      ]}
      selected={policies.orbit.navigation}
      onselect={(target) => {
        void model.run('swf.navigation.set', { target: target as 'camera' | 'orbit' });
      }}
    />
  {/if}
  <IconButton
    handle={handleOf`editor.actions.undo`}
    icon="undo"
    label={t('command.history.undo')}
    size="small"
    disabled={!model.history.undo}
    onpress={() => {
      void model.run('swf.history.undo', {});
    }}
  />
  <IconButton
    handle={handleOf`editor.actions.redo`}
    icon="redo"
    label={t('command.history.redo')}
    size="small"
    disabled={!model.history.redo}
    onpress={() => {
      void model.run('swf.history.redo', {});
    }}
  />
  <IconButton
    handle={handleOf`editor.actions.commands`}
    icon="search"
    label={t('palette.open')}
    size="small"
    disabled={model.app === null}
    onpress={() => {
      paletteOpen = true;
    }}
  />
  <IconButton
    handle={handleOf`editor.actions.toggle-panel`}
    icon="panel-bottom"
    label={t('panel.toggle')}
    size="small"
    pressed={panelOpen}
    onpress={() => {
      panelOpen = !panelOpen;
    }}
  />
{/snippet}

{#snippet panelEnd()}
  {#if status !== null}
    <StatusItem
      handle={handleOf`application.panel.scene`}
      label={t('scene.summary', {
        preset: t(PRESETS[status.scene.preset].name),
        seed: status.scene.seed,
        windows: status.windows,
      })}
    />
  {/if}
  {#if policies !== null}
    <StatusItem
      handle={handleOf`application.panel.navigation`}
      label={t(
        policies.orbit.navigation === 'orbit' ? 'navigation.status.orbit' : 'navigation.status.camera',
      )}
    />
  {/if}
  {#if saveStatus !== null}
    <StatusItem handle={handleOf`application.panel.save`} label={saveStatus} icon="save" />
  {/if}
  {#if model.panoramaFocused}
    <!-- The panorama has the keyboard: what its keys do, where the reader looks for hints. -->
    <StatusItem
      handle={handleOf`application.panel.keys`}
      label={t('panorama.keys.short')}
      title={t('panorama.keys')}
      icon="hint"
    />
  {:else if model.status?.mode === FOCUS_ID}
    <StatusItem
      handle={handleOf`application.panel.focus`}
      label={t('focus.hint.short')}
      title={t('focus.hint')}
      icon="hint"
    />
  {:else}
    <StatusItem
      handle={handleOf`application.panel.takeover`}
      label={t('view.takeover.short')}
      title={t('view.takeover')}
      icon="hint"
    />
  {/if}
  <IconButton
    handle={handleOf`application.panel.toggle`}
    icon={panelOpen ? 'chevron-down' : 'chevron-up'}
    label={panelOpen ? t('panel.fold') : t('panel.unfold')}
    size="small"
    onpress={() => {
      panelOpen = !panelOpen;
    }}
  />
{/snippet}

{#snippet panelHead()}
  <Tabs
    handle={handleOf`application.panel.tabs`}
    ariaLabel={t('panel.label')}
    variant="panel"
    items={[{ value: 'status', label: t('status.title') }]}
    selected="status"
    onselect={() => {
      panelOpen = true;
    }}
    end={panelEnd}
  />
{/snippet}

{#snippet panelBody()}
  <StatusBody {model} />
{/snippet}

<Application
  labels={false}
  workshop={{
    views: leftViews,
    active: leftView,
    width: widths.left,
    minWidth: 220,
    maxWidth: 480,
    onselect: (view) => {
      leftView = leftView === view ? null : view;
    },
    onresize: (delta) => {
      widths = { ...widths, left: Math.max(220, Math.min(480, widths.left + delta)) };
    },
    view: leftContent,
  }}
  worktree={{
    views: rightViews,
    active: rightView,
    width: widths.right,
    minWidth: 220,
    maxWidth: 480,
    onselect: (view) => {
      rightView = rightView === view ? null : view;
    },
    onresize: (delta) => {
      widths = { ...widths, right: Math.max(220, Math.min(480, widths.right + delta)) };
    },
    view: rightContent,
  }}
  centre={{ label: t('view.label'), view: centreView, actions: editorActions }}
  panel={{
    open: panelOpen,
    height: panelHeight,
    minHeight: 80,
    maxHeight: 360,
    onresize: (delta) => {
      panelHeight = Math.max(80, Math.min(360, panelHeight + delta));
    },
    head: panelHead,
    body: panelBody,
  }}
/>

<!-- What is said to assistive technology alone: the application's one announcer. -->
<Announcer />

{#if model.pendingReplace !== null}
  <ReplaceDialog {model} pending={model.pendingReplace} />
{/if}

{#if paletteOpen}
  <Palette
    {model}
    experimental={experiments !== null}
    onclose={() => {
      paletteOpen = false;
    }}
  />
{/if}
