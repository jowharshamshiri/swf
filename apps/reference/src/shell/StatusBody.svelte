<script lang="ts">
  // THE WORKSPACE NOW: how many windows the space holds, how many the panorama shows and how many
  // lie behind the camera, how the windows are shown for their distance, and where the camera
  // faces. The frame's own measures are the developer view's.
  import { Stack, Stat, StatGroup } from '@wsb/uikit/components';
  import type { MessageId } from '../messages.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);
  const count = (value: number) => model.messages.number(value);

  const space = $derived(model.space);
</script>

<Stack inset>
  <StatGroup ariaLabel={t('space.label')}>
    {#if space === null}
      <Stat label={t('space.windows')} busy />
    {:else}
      <Stat label={t('space.windows')} value={count(space.windows)} />
      <Stat label={t('space.inView')} value={count(space.inView)} />
      <Stat label={t('space.behind')} value={count(space.behind)} />
      <Stat
        label={t('space.facing')}
        value={t('space.facing.value', { value: space.facing })}
      />
      <Stat label={t('space.full')} value={count(space.shown.full)} />
      <Stat label={t('space.compact')} value={count(space.shown.compact)} />
      <Stat label={t('space.named')} value={count(space.shown.label)} />
    {/if}
  </StatGroup>
</Stack>
