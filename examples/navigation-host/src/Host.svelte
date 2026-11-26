<script lang="ts">
  // A HOST'S WINDOW, laid out by the kit as a workbench lays its own: which navigation controls
  // are on, and the experiments, on the left; the radar and the inspector on the right; the host's
  // own content as the whole centre, presented by the framework with the navigation controls; and
  // how it is presented in the panel below. Every navigation control is the package's, mounted
  // here or not as the Components view says; the view controls can be the host's own.
  import { Announcer, announce, Checkbox, IconButton, Notice, Panel, Section, Segmented, Stack, StatusItem, Tabs, Text } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { Application } from '@wsb/uikit/surfaces/application';
  import { untrack } from 'svelte';
  import type { BackendId } from '@swf/navigation';
  import {
    ExperimentPanel,
    Inspector,
    ModeSwitcher,
    NavigationCentre,
    navigationKey,
    Panorama,
    Radar,
  } from '@swf/navigation-ui';
  import HostViewControls from './HostViewControls.svelte';
  import type { Host } from './host.svelte.js';

  interface Props {
    host: Host;
  }

  let { host }: Props = $props();
  const model = $derived(host.model);
  const t = $derived(host.t);
  const on = $derived(host.components);

  let leftView = $state<string | null>('components');
  let rightView = $state<string | null>('selection');
  let radarOpen = $state(true);
  let widths = $state({ left: 300, right: 300 });
  let panelOpen = $state(true);
  let panelHeight = $state(96);

  // What navigation did that is not shown as text is said, each announcement once.
  $effect(() => {
    const said = model.announcement;
    if (said !== null) {
      untrack(() => {
        announce(said.text);
      });
    }
  });
  // A window asked to be inspected opens the selection's side.
  $effect(() => {
    if (model.inspections > 0) {
      untrack(() => {
        rightView = 'selection';
      });
    }
  });

  const toggles = $derived([
    { key: 'switcher', label: t('host.component.switcher') },
    { key: 'radar', label: t('host.component.radar') },
    { key: 'inspector', label: t('host.component.inspector') },
    { key: 'strip', label: t('host.component.strip') },
    { key: 'map', label: t('host.component.map') },
    { key: 'overview', label: t('host.component.overview') },
    { key: 'experiments', label: t('host.component.experiments') },
  ] as const);

  const backendLabel = (backend: BackendId | null) =>
    backend === null ? t('host.backend.none') : t(`host.backend.${backend}`);
</script>

<svelte:window
  onkeydown={(event) => {
    navigationKey(model, event);
  }}
/>

{#snippet leftContent(view: string)}
  {#if view === 'components'}
    <Panel title={t('host.components')} titled={false} handle={handleOf`workshop.components`}>
      <Stack inset>
        <Section title={t('host.components')} detail={t('host.components.detail')} handle={handleOf`workshop.components.list`}>
          <Stack gap="small">
        {#each toggles as toggle (toggle.key)}
          <Checkbox
            handle={handleOf`workshop.components.${toggle.key}`}
            id={`host-component-${toggle.key}`}
            label={toggle.label}
            checked={on[toggle.key]}
            onchange={(checked) => {
              host.components = { ...host.components, [toggle.key]: checked };
            }}
          />
        {/each}
        <Checkbox
          handle={handleOf`workshop.components.controls`}
          id="host-component-controls"
          label={t('host.component.controls')}
          checked={on.controls !== 'none'}
          onchange={(checked) => {
            host.components = { ...host.components, controls: checked ? 'package' : 'none' };
          }}
        />
        <Checkbox
          handle={handleOf`workshop.components.own-controls`}
          id="host-component-controls-own"
          label={t('host.component.controls.own')}
          checked={on.controls === 'own'}
          disabled={on.controls === 'none'}
          onchange={(checked) => {
            host.components = { ...host.components, controls: checked ? 'own' : 'package' };
          }}
        />
          </Stack>
        </Section>
      </Stack>
    </Panel>
  {:else if view === 'experiments'}
    {#if on.experiments}
      <ExperimentPanel {model} />
    {:else}
      <Stack inset><Text quiet>{t('host.experiments.off')}</Text></Stack>
    {/if}
  {/if}
{/snippet}

{#snippet rightContent(view: string)}
  {#if view === 'selection'}
    <Stack fill gap="small">
      {#if on.radar}
        <Radar
          {model}
          open={radarOpen}
          ontoggle={(open) => {
            radarOpen = open;
          }}
        />
      {/if}
      {#if on.inspector}
        <Stack grow>
          <Inspector {model} />
        </Stack>
      {/if}
      {#if !on.radar && !on.inspector}
        <Stack inset><Text quiet>{t('host.selection.off')}</Text></Stack>
      {/if}
    </Stack>
  {/if}
{/snippet}

{#snippet ownControls()}
  <HostViewControls {model} {t} />
{/snippet}

{#snippet problem()}
  {#if host.problem !== null}
    <Notice tone="danger" title={host.problem} handle={handleOf`page.panorama.problem`} />
  {/if}
{/snippet}

{#snippet panorama()}
  <Panorama
    {model}
    onsurface={(surface) => host.start(surface)}
    notices={problem}
    controls={on.controls === 'package' ? undefined : on.controls === 'own' ? ownControls : null}
  />
{/snippet}

{#snippet centreView()}
  <NavigationCentre
    {model}
    {panorama}
    strip={on.strip ? undefined : null}
    map={on.map ? undefined : null}
    overview={on.overview ? undefined : null}
  />
{/snippet}

{#snippet centreActions()}
  {#if on.switcher}
    <ModeSwitcher {model} />
  {/if}
  <IconButton
    handle={handleOf`editor.actions.undo`}
    icon="undo"
    label={t('host.undo')}
    size="small"
    disabled={!model.history.undo}
    onpress={() => {
      void model.runNavigation('swf.history.undo', {});
    }}
  />
  <IconButton
    handle={handleOf`editor.actions.redo`}
    icon="redo"
    label={t('host.redo')}
    size="small"
    disabled={!model.history.redo}
    onpress={() => {
      void model.runNavigation('swf.history.redo', {});
    }}
  />
{/snippet}

{#snippet panelEnd()}
  {#if model.status !== null}
    <StatusItem
      handle={handleOf`application.panel.summary`}
      label={t('host.status.summary', {
        windows: model.status.windows,
        mode: model.messages.named(`mode.${model.status.mode}`),
        backend: backendLabel(model.status.backend),
      })}
    />
  {/if}
{/snippet}

{#snippet panelHead()}
  <Tabs
    handle={handleOf`application.panel.tabs`}
    ariaLabel={t('host.status')}
    variant="panel"
    items={[{ value: 'status', label: t('host.status') }]}
    selected="status"
    onselect={() => {
      panelOpen = true;
    }}
    end={panelEnd}
  />
{/snippet}

{#snippet panelBody()}
  <Stack inset direction="row" gap="medium" align="center">
    <Text>{t('host.backend')}</Text>
    <Segmented
      handle={handleOf`application.panel.backend`}
      ariaLabel={t('host.backend')}
      items={[
        { value: 'dom', label: t('host.backend.dom') },
        { value: 'geometry', label: t('host.backend.geometry') },
      ]}
      selected={model.status?.backend ?? 'geometry'}
      onselect={(backend) => {
        void model.runNavigation('swf.backend.switch', { backend: backend as BackendId });
      }}
    />
  </Stack>
{/snippet}

<Application
  labels={false}
  workshop={{
    views: [
      { id: 'components', icon: 'settings', label: t('host.components') },
      { id: 'experiments', icon: 'tool', label: t('host.experiments') },
    ],
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
    views: [{ id: 'selection', icon: 'info', label: t('host.selection') }],
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
  centre={{ label: t('host.view'), view: centreView, actions: centreActions }}
  panel={{
    open: panelOpen,
    height: panelHeight,
    minHeight: 64,
    maxHeight: 240,
    onresize: (delta) => {
      panelHeight = Math.max(64, Math.min(240, panelHeight + delta));
    },
    head: panelHead,
    body: panelBody,
  }}
/>

<Announcer />
