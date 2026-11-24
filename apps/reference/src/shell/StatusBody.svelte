<script lang="ts">
  // HOW THE PANORAMA IS PRESENTED: its backend, and the last frame's measures.
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

  const status = $derived(model.status);
  const frame = $derived(model.frame);
</script>

<Stack inset>
  <StatGroup ariaLabel={t('status.label')}>
    {#if status === null}
      <Stat label={t('status.backend')} busy />
    {:else}
      <Stat
        label={t('status.backend')}
        value={status.backend === null ? t('status.backend.none') : t(`backend.${status.backend}`)}
      />
    {/if}
    {#if frame === null}
      <Stat label={t('status.frame')} title={t('status.pending')} value="—" />
    {:else}
      <Stat
        label={t('status.frame')}
        value={t('status.frame.value', { value: Number(frame.durationMs.toFixed(1)) })}
      />
      <Stat label={t('status.fragments')} value={count(frame.fragments)} />
      <Stat label={t('status.live')} value={count(frame.live)} />
      <Stat label={t('status.writes')} value={count(frame.writes)} />
      <Stat label={t('status.fallbacks')} value={count(model.fallbacks)} />
    {/if}
  </StatGroup>
</Stack>
