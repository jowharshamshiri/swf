<script lang="ts">
  // THE REFERENCE APPLICATION'S WINDOW, as the kit lays a window out: the scene and the list of
  // windows on the left, what is selected on the right, the panorama as the centre's document
  // with the view's commands at its strip's end, and how it is presented in the panel below.
  // A narrow window floats one side at a time over the panorama, so nothing is lost.
  import { Badge, IconButton, Segmented, StatusItem, Tabs } from '@wsb/uikit/components';
  import type { TabAction } from '@wsb/uikit/components';
  import { EmptyState, Button } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { Workbench } from '@wsb/uikit/host/workbench';
  import { Application } from '@wsb/uikit/surfaces/application';
  import type { Direction } from '@wsb/uikit/surfaces/application';
  import { BACKEND_IDS } from '../config.js';
  import type { BackendId } from '../config.js';
  import type { MessageId } from '../messages.js';
  import { PRESETS } from '../presets.js';
  import type { Component } from 'svelte';
  import InspectorView from './InspectorView.svelte';
  import type { ShellModel } from './model.svelte.js';
  import Palette from './Palette.svelte';
  import PanoramaDocument from './PanoramaDocument.svelte';
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

  /** The centre's one document. */
  const PANORAMA_TAB = 'panorama';
  const bench = new Workbench<typeof PANORAMA_TAB>();
  const openPanorama = () => {
    bench.open(
      { key: PANORAMA_TAB, label: t('view.tab'), icon: 'home', input: PANORAMA_TAB },
      { keep: true },
    );
  };
  openPanorama();

  let leftView = $state<string | null>('scene');
  let rightView = $state<string | null>('inspector');
  let widths = $state({ left: 280, right: 280 });
  let panelOpen = $state(true);
  let panelHeight = $state(190);
  let paletteOpen = $state(false);

  const SPLITS: Readonly<Record<string, Direction>> = {
    'split-up': 'up',
    'split-down': 'down',
    'split-left': 'left',
    'split-right': 'right',
  };

  function tabAction(group: string, key: string, action: TabAction): void {
    switch (action) {
      case 'close':
      case 'close-others':
      case 'close-to-right':
        // The panorama is the only document: closing others or those after it closes nothing.
        if (action === 'close') {
          bench.close(group, key);
        }
        return;
      case 'keep':
        bench.keep(group, key);
        return;
      case 'beside':
        openPanoramaBeside();
        return;
      case 'copy-address':
        throw new Error('the panorama has no address to copy');
      default: {
        const side = SPLITS[action];
        if (side === undefined) {
          throw new Error(`no answer to the tab action ${action}`);
        }
        bench.split(group, side, key);
      }
    }
  }

  function openPanoramaBeside(): void {
    bench.open(
      { key: PANORAMA_TAB, label: t('view.tab'), icon: 'home', input: PANORAMA_TAB },
      { keep: true, beside: true },
    );
  }

  /** Opens the command list as VS Code opens its command palette: Ctrl+Shift+P, or F1. */
  function onkeydown(event: KeyboardEvent): void {
    const palette =
      event.key === 'F1' ||
      ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p');
    if (palette && model.app !== null) {
      event.preventDefault();
      paletteOpen = true;
    }
  }

  const sideViews = (views: { id: string; icon: 'plans' | 'list' | 'info' | 'statistics'; label: string }[]) => views;
  const leftViews = $derived(
    sideViews([
      { id: 'scene', icon: 'plans', label: t('scene.title') },
      { id: 'windows', icon: 'list', label: t('windows.title') },
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
  const modes = $derived(
    (model.app?.modes.list() ?? []).map((mode) => ({ value: mode.id, label: t(mode.name) })),
  );
  const backends = $derived(BACKEND_IDS.map((id) => ({ value: id, label: t(`backend.${id}`) })));
  const status = $derived(model.status);
  const groups = $derived(bench.groups.map((group) => ({ ...group, tabs: group.tabs.map((tab) => ({ ...tab })) })));
</script>

<svelte:window {onkeydown} />

{#snippet leftContent(view: string)}
  {#if view === 'scene'}
    <SceneView {model} />
  {:else if view === 'windows'}
    <WindowsView {model} />
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

{#snippet content(_group: string, key: string)}
  {#if key === PANORAMA_TAB}
    <PanoramaDocument {model} />
  {/if}
{/snippet}

{#snippet empty(_group: string)}
  <EmptyState icon="home" title={t('panorama.closed.title')} detail={t('panorama.closed.detail')}>
    {#snippet action()}
      <Button
        handle={handleOf`editor.panorama.open`}
        label={t('panorama.open')}
        variant="primary"
        onpress={openPanorama}
      />
    {/snippet}
  </EmptyState>
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
  centre={{
    groups,
    grid: bench.grid,
    focused: bench.focused,
    keyboard: bench.keyboard,
    onfocus: (group) => {
      bench.focus(group);
    },
    onactivate: (group, tab) => {
      bench.activate(group, tab);
    },
    onkeep: (group, tab) => {
      bench.keep(group, tab);
    },
    onclose: (group, tab) => {
      bench.close(group, tab);
    },
    ontabaction: tabAction,
    ondrop: (from, to) => {
      bench.drop(from, to);
    },
    onmove: (from, to) => {
      bench.move(from, to);
    },
    onresize: (split, index, delta, extent) => {
      bench.resize(split, index, delta, extent);
    },
    content,
    empty,
    actions: editorActions,
  }}
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
