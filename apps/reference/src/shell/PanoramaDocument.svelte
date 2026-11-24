<script lang="ts">
  // THE PANORAMA, as a document of the centre: full-bleed, named by its tab. The workspace is
  // presented in the surface the kit hands out, and follows the document wherever it is shown.
  // An empty workspace says so above it, with the way to fill it.
  import { Button, EmptyState, Notice, ScaledView, Stack } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { onMount } from 'svelte';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: Parameters<typeof model.messages.format>[0]) => model.messages.format(id);

  let surface: HTMLElement | undefined = $state();

  onMount(() => {
    if (surface === undefined) {
      throw new Error('the panorama document has no surface to present in');
    }
    void model.present(surface);
  });
</script>

<Stack fill gap="small">
  {#if model.startProblem !== null}
    <Notice tone="danger" title={model.startProblem} handle={handleOf`page.panorama.problem`} />
  {/if}
  {#if model.status !== null && model.status.windows === 0}
    <EmptyState title={t('empty.title')} detail={t('empty.body')} icon="add">
      {#snippet action()}
        <Button
          handle={handleOf`page.panorama.load`}
          label={t('empty.action')}
          variant="primary"
          onpress={() => {
            void model.run('reference.preset.load', { preset: 'sparse' });
          }}
        />
      {/snippet}
    </EmptyState>
  {/if}
  <Stack grow>
    <ScaledView ariaLabel={t('view.label')} handle={handleOf`page.panorama`} bind:surface />
  </Stack>
</Stack>
