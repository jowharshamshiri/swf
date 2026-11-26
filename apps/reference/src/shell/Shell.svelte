<script lang="ts">
  // THE REFERENCE APPLICATION'S WINDOW, as the kit lays a window out: the scene and the list of
  // windows on the left, what is selected on the right, the panorama as the whole centre with
  // the view's commands across its top, and how it is presented in the panel below. A narrow
  // window floats one side at a time over the panorama, so nothing is lost.
  import {
    announce,
    Announcer,
    Button,
    EmptyState,
    IconButton,
    Notice,
    Stack,
    StatusItem,
    Tabs,
    Text,
    Toolbar,
  } from '@wsb/uikit/components';
  import {
    Inspector,
    ModeSwitcher,
    NavigationCentre,
    navigationKey,
    Panorama,
    Radar,
    takesTyping,
  } from '@swf/navigation-ui';
  import { DEFAULT_CONFIG } from '../config.js';
  import { FOCUS_ID } from '@swf/navigation';
  import { handleOf } from '@wsb/uikit/handles';
  import { Application } from '@wsb/uikit/surfaces/application';
  import type { MessageId } from '../messages.js';
  import { PRESETS } from '../presets.js';
  import type { Component } from 'svelte';
  import { tick, untrack } from 'svelte';
  import type { ShellModel } from './model.svelte.js';
  import Palette from './Palette.svelte';
  import SceneView from './SceneView.svelte';
  import ScenariosView from './ScenariosView.svelte';
  import StatusBody from './StatusBody.svelte';
  import WindowsView from './WindowsView.svelte';
  import WorkspacesView from './WorkspacesView.svelte';
  import ReplaceDialog from './ReplaceDialog.svelte';
  import SwitchDialog from './SwitchDialog.svelte';

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
   * which keep their own (UX-012). As VS Code: Ctrl+Shift+P or F1 opens the command list, and
   * Ctrl+S saves now (Cmd on a Mac); every other key is navigation's ({@link navigationKey}).
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
    if (event.defaultPrevented || paletteOpen || takesTyping(event.target) || model.app === null) {
      return;
    }
    if (command && !event.altKey && key === 's' && !event.shiftKey) {
      event.preventDefault();
      void model.run('reference.workspace.saveNow', {});
      return;
    }
    navigationKey(model, event);
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
    if (model.refusal !== null && model.placeOf(model.refusal) === 'inspector') {
      rightView = 'inspector';
    }
  });
  // A scenario started from anywhere (the command list among them) shows its steps.
  $effect(() => {
    if (model.scenarioStarts > 0) {
      leftView = 'scenarios';
    }
  });

  // A restore that failed (the workspace saved last, a named one, a file), until dismissed.
  let dismissedRestore = $state<unknown>(null);
  const restoreProblem = $derived.by(() => {
    const error = model.workspaces?.restoreError ?? null;
    return error === null || error === dismissedRestore ? null : error;
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
  const status = $derived(model.status);
  const scene = $derived(model.scene);
  /** The space shown, once one is. */
  const shownSpace = $derived(model.workspaces?.space ?? null);

  /** Saving what is shown as a new space is done in the Workspaces view: it opens on its name. */
  async function newSpace(): Promise<void> {
    leftView = 'workspaces';
    await tick();
    document.getElementById('reference-workspace-name')?.focus();
  }
  const policies = $derived(model.policies);
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
      <Radar
        {model}
        open={radarOpen}
        ontoggle={(open) => {
          radarOpen = open;
        }}
      />
      <Stack grow>
        <Inspector {model} />
      </Stack>
    </Stack>
  {:else if developer !== null && view === 'developer'}
    {@const Developer = developer}
    <Developer {model} />
  {/if}
{/snippet}

{#snippet startNotice()}
  {#if model.startProblem !== null}
    <Notice tone="danger" title={model.startProblem} handle={handleOf`page.panorama.problem`} />
  {/if}
{/snippet}

{#snippet restoreBar()}
  {#if restoreProblem !== null}
    <Toolbar ariaLabel={t('restore.failed', { reason: restoreProblem.message })}>
      <Text>{t('restore.failed', { reason: restoreProblem.message })}</Text>
      {#snippet end()}
        <IconButton
          handle={handleOf`page.restore.dismiss`}
          icon="close"
          label={t('notice.dismiss')}
          size="small"
          onpress={() => {
            dismissedRestore = restoreProblem;
          }}
        />
      {/snippet}
    </Toolbar>
  {/if}
{/snippet}

{#snippet emptyWorkspace()}
  <EmptyState title={t('empty.title')} detail={t('empty.body')} icon="add">
    {#snippet action()}
      <Stack direction="row" gap="small" justify="center" wrap>
        <Button
          handle={handleOf`page.panorama.load`}
          label={t('empty.action')}
          variant="primary"
          onpress={() => {
            void model.run('reference.preset.load', { preset: DEFAULT_CONFIG.preset });
          }}
        />
        <Button
          handle={handleOf`page.panorama.add`}
          label={t('command.window.add')}
          icon="add"
          onpress={() => {
            void model.run('reference.window.add', {});
          }}
        />
      </Stack>
    {/snippet}
  </EmptyState>
{/snippet}

{#snippet panorama()}
  <Panorama
    {model}
    onsurface={(surface) => model.start(surface)}
    notices={startNotice}
    bars={restoreBar}
    empty={emptyWorkspace}
  />
{/snippet}

{#snippet spacesEnd()}
  <IconButton
    handle={handleOf`editor.spaces.new`}
    icon="add"
    label={t('spaces.new')}
    size="small"
    onpress={() => {
      void newSpace();
    }}
  />
{/snippet}

{#snippet centreView()}
  <Stack fill gap="small">
    <!-- The spaces across the top of the centre, each shown in one press: while saving is on. -->
    {#if persisting && shownSpace !== null && model.spaces.length > 1}
      <Tabs
        handle={handleOf`editor.spaces`}
        ariaLabel={t('spaces.label')}
        variant="panel"
        items={model.spaces.map((space) => ({ value: space.name, label: space.name }))}
        selected={shownSpace}
        onselect={(name) => {
          if (name !== shownSpace) {
            void model.switchTo(name);
          }
        }}
        end={spacesEnd}
      />
    {/if}
    <Stack grow>
      <NavigationCentre {model} {panorama} />
    </Stack>
  </Stack>
{/snippet}

{#snippet editorActions()}
  <ModeSwitcher {model} />
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
  {#if scene !== null && status !== null}
    <StatusItem
      handle={handleOf`application.panel.scene`}
      label={t('scene.summary', {
        preset: t(PRESETS[scene.preset].name),
        seed: scene.seed,
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

{#if model.workspaces?.asking}
  <SwitchDialog {model} asking={model.workspaces.asking} />
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
