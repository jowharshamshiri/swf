<script lang="ts">
  // THE RADAR, beside the panorama while it is in use: the workspace round the camera from above,
  // what its marks mean, and two things done from it — centring the view on the selected window,
  // and arranging every window round the camera. It folds to its head, as a view in a side bar
  // folds, and opens again from there.
  import { Button, IconButton, Notice, SectionLabel, Stack, Text, Toolbar } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import type { MessageId } from '../messages.js';
  import type { ShellModel } from './model.svelte.js';
  import RadarStage from './RadarStage.svelte';

  interface Props {
    model: ShellModel;
    open: boolean;
    ontoggle: (open: boolean) => void;
  }

  let { model, open, ontoggle }: Props = $props();
  const t = (id: MessageId) => model.messages.format(id);
  const refusal = $derived(
    model.refusal !== null && model.isRadarRefusal(model.refusal) ? model.refusal : null,
  );
</script>

{#snippet head()}
  <Toolbar ariaLabel={t('radar.title')}>
    <IconButton
      handle={handleOf`page.radar.toggle`}
      icon={open ? 'chevron-down' : 'chevron-right'}
      label={open ? t('radar.hide') : t('radar.show')}
      size="small"
      onpress={() => {
        ontoggle(!open);
      }}
    />
    <SectionLabel text={t('radar.title')} />
  </Toolbar>
{/snippet}

{#if !open}
  {@render head()}
{:else}
  <Stack grow fill gap="small">
    {@render head()}
    <Stack grow>
      <RadarStage {model} />
    </Stack>
    <Stack inset gap="small">
      <Text quiet>{t('radar.legend')}</Text>
      <Stack direction="row" gap="small" wrap>
        <Button
          handle={handleOf`page.radar.locate`}
          label={t('radar.locate')}
          icon="show"
          size="small"
          disabled={model.selected === null}
          onpress={() => {
            if (model.selected !== null) {
              void model.run('swf.window.reveal', { id: model.selected.id });
            }
          }}
        />
        <Button
          handle={handleOf`page.radar.arrange`}
          label={t('radar.arrange')}
          size="small"
          disabled={model.status === null || model.status.windows === 0}
          onpress={() => {
            void model.run('swf.window.arrange', {});
          }}
        />
      </Stack>
      {#if refusal !== null}
        <Notice tone="danger" title={model.refusalText(refusal)} handle={handleOf`page.radar.refusal`} />
      {/if}
    </Stack>
  </Stack>
{/if}
