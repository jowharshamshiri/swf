<script lang="ts">
  // THE VIEW'S SWITCHER, for the editor's actions over the panorama: the view modes (the panorama,
  // focus, the map, the overview) as the kit's segmented control, a list when the panorama is too
  // narrow, or a badge while there is one mode; and, while workspace orbit is on, what a drag on
  // the background turns, the camera or the workspace.
  import { Badge, Segmented, Select } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import type { NavigationMessageId } from './messages.js';
  import type { NavigationModel } from './model.svelte.js';
  import { compactView, offeredModes } from './modes.js';

  interface Props {
    model: NavigationModel;
  }

  let { model }: Props = $props();
  const t = (id: NavigationMessageId) => model.messages.format(id);
  const status = $derived(model.status);
  const policies = $derived(model.policies);
  const modes = $derived(offeredModes(model));
  const compact = $derived(compactView(model));
</script>

{#if status !== null && modes.length === 1}
  <!-- One mode is not a choice: it is said, and becomes a switcher once a second registers. -->
  <Badge handle={handleOf`editor.actions.mode`} label={modes[0]?.label ?? status.mode} title={t('mode.label')} />
{:else if status !== null && modes.length > 1 && compact}
  <Select
    handle={handleOf`editor.actions.mode`}
    id="swf-mode"
    ariaLabel={t('mode.label')}
    options={modes.map((mode) => ({ value: mode.value, label: mode.label, disabled: mode.disabled }))}
    value={status.mode}
    onchange={(mode) => {
      void model.runNavigation('swf.mode.switch', { mode });
    }}
  />
{:else if status !== null && modes.length > 1}
  <Segmented
    handle={handleOf`editor.actions.mode`}
    ariaLabel={t('mode.label')}
    items={modes}
    selected={status.mode}
    onselect={(mode) => {
      void model.runNavigation('swf.mode.switch', { mode });
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
        title: policies.orbit.rootId === null ? t('orbit.navigation.noroot') : t('command.navigation.orbit'),
      },
    ]}
    selected={policies.orbit.navigation}
    onselect={(target) => {
      void model.runNavigation('swf.navigation.set', { target: target as 'camera' | 'orbit' });
    }}
  />
{/if}
