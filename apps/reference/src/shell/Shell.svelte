<script lang="ts">
  // THE REFERENCE APPLICATION'S WINDOW, as the kit lays a window out: the scene and the list of
  // windows on the left, what is selected on the right, the panorama as the whole centre with
  // the view's commands across its top, and how it is presented in the panel below. A narrow
  // window floats one side at a time over the panorama, so nothing is lost.
  import { Badge, IconButton, Segmented, StatusItem, Tabs } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { Application } from '@wsb/uikit/surfaces/application';
  import { BACKEND_IDS } from '../config.js';
  import type { BackendId } from '../config.js';
  import type { MessageId } from '../messages.js';
  import { PRESETS } from '../presets.js';
  import type { Component } from 'svelte';
  import InspectorView from './InspectorView.svelte';
  import type { ShellModel } from './model.svelte.js';
  import Palette from './Palette.svelte';
  import CentreView from './CentreView.svelte';
  import FeaturesView from './FeaturesView.svelte';
  import { FOCUS_ID } from '../focus.js';
  import SceneView from './SceneView.svelte';
  import StatusBody from './StatusBody.svelte';
  import WindowsView from './WindowsView.svelte';

  interface Props {
    model: ShellModel;
    /**
     * The debug overlay's view, in staging builds and development; production builds have none,
     * and carry nothing of it.
     */
    diagnostics?: Component<{ model: ShellModel }> | null;
  }

  let { model, diagnostics = null }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  let leftView = $state<string | null>('scene');
  let rightView = $state<string | null>('inspector');
  let widths = $state({ left: 280, right: 280 });
  let panelOpen = $state(true);
  let panelHeight = $state(190);
  let paletteOpen = $state(false);

  /**
   * Opens the command list as VS Code opens its command palette: Ctrl+Shift+P, or F1. Escape
   * closes the focus, as it leaves VS Code's zen mode, unless something else took it first or it
   * was pressed in a field or in a window's own content.
   */
  function onkeydown(event: KeyboardEvent): void {
    const palette =
      event.key === 'F1' ||
      ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p');
    if (palette && model.app !== null) {
      event.preventDefault();
      paletteOpen = true;
      return;
    }
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest('input, textarea, select, [data-swf-viewport] [data-swf-surface]') !== null);
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !paletteOpen &&
      !typing &&
      model.status?.mode === FOCUS_ID
    ) {
      event.preventDefault();
      void model.run('reference.focus.exit', {});
    }
  }

  // A window asked to be inspected: the inspector opens on it.
  $effect(() => {
    if (model.inspections > 0) {
      rightView = 'inspector';
    }
  });

  const sideViews = (
    views: { id: string; icon: 'plans' | 'list' | 'info' | 'statistics' | 'settings'; label: string }[],
  ) => views;
  const leftViews = $derived(
    sideViews([
      { id: 'scene', icon: 'plans', label: t('scene.title') },
      { id: 'windows', icon: 'list', label: t('windows.title') },
      { id: 'features', icon: 'settings', label: t('features.title') },
    ]),
  );
  const rightViews = $derived(
    sideViews([
      { id: 'inspector', icon: 'info', label: t('inspector.title') },
      ...(diagnostics === null
        ? []
        : [{ id: 'diagnostics', icon: 'statistics' as const, label: t('diagnostics.title') }]),
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
    (model.app?.modes.list() ?? []).map((mode) => ({
      value: mode.id,
      label: t(mode.name),
      disabled: mode.id === FOCUS_ID && !focusable,
    })),
  );
  const backends = $derived(BACKEND_IDS.map((id) => ({ value: id, label: t(`backend.${id}`) })));
  const status = $derived(model.status);
  const policies = $derived(model.policies);
</script>

<svelte:window {onkeydown} />

{#snippet leftContent(view: string)}
  {#if view === 'scene'}
    <SceneView {model} />
  {:else if view === 'windows'}
    <WindowsView {model} />
  {:else if view === 'features'}
    <FeaturesView {model} />
  {/if}
{/snippet}

{#snippet rightContent(view: string)}
  {#if view === 'inspector'}
    <InspectorView {model} />
  {:else if diagnostics !== null && view === 'diagnostics'}
    {@const Diagnostics = diagnostics}
    <Diagnostics {model} />
  {/if}
{/snippet}

{#snippet centreView()}
  <CentreView {model} />
{/snippet}

{#snippet editorActions()}
  {#if status !== null && modes.length === 1}
    <!-- One mode is not a choice: it is said, and becomes a switcher once a second registers. -->
    <Badge handle={handleOf`editor.actions.mode`} label={modes[0]?.label ?? status.mode} title={t('mode.label')} />
  {:else if status !== null && modes.length > 1}
    <Segmented
      handle={handleOf`editor.actions.mode`}
      ariaLabel={t('mode.label')}
      items={modes}
      selected={status.mode}
      onselect={(mode) => {
        void model.run('reference.mode.switch', { mode });
      }}
    />
  {/if}
  {#if policies !== null && policies.features.enabled.orbit}
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
        void model.run('reference.navigation.set', { target: target as 'camera' | 'orbit' });
      }}
    />
  {/if}
  {#if status !== null}
    <Segmented
      handle={handleOf`editor.actions.backend`}
      ariaLabel={t('backend.label')}
      items={backends}
      selected={status.backend ?? ''}
      onselect={(backend) => {
        void model.run('reference.backend.switch', { backend: backend as BackendId });
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
      void model.run('reference.history.undo', {});
    }}
  />
  <IconButton
    handle={handleOf`editor.actions.redo`}
    icon="redo"
    label={t('command.history.redo')}
    size="small"
    disabled={!model.history.redo}
    onpress={() => {
      void model.run('reference.history.redo', {});
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
  <StatusItem handle={handleOf`application.panel.takeover`} label={t('view.takeover')} icon="hint" />
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

{#if paletteOpen}
  <Palette
    {model}
    onclose={() => {
      paletteOpen = false;
    }}
  />
{/if}
