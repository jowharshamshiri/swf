<script lang="ts">
  // THE PANORAMA: the workspace presented in the surface the kit hands out. An empty workspace
  // says so above it, with the way to fill it. In focus, a bar above names the focused window and
  // closes the focus, and a row below holds the windows around it, those to its left on the left
  // and those to its right on the right, nearest the focus in the middle: each pressed focuses it.
  import { Button, EmptyState, IconButton, Notice, ScaledView, Stack, Text, Toolbar } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import { onMount } from 'svelte';
  import { FOCUS_ID } from '../focus.js';
  import type { Neighbour } from '../focus.js';
  import type { MessageId } from '../messages.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  /** Windows shown each side of the focus; the rest are a step away. */
  const NEAREST = 3;

  let surface: HTMLElement | undefined = $state();

  onMount(() => {
    if (surface === undefined) {
      throw new Error('the panorama has no surface to present in');
    }
    void model.start(surface);
  });

  const focus = $derived.by(() => {
    void model.revision;
    const app = model.app;
    if (app === null || model.status?.mode !== FOCUS_ID) {
      return null;
    }
    const state = app.workspace.getState();
    const id = state.focusedId;
    const context = app.focusNeighbours();
    if (id === null || context === null) {
      return null;
    }
    return {
      label: state.nodes.get(id)?.label ?? id,
      left: context.left.slice(0, NEAREST).reverse(),
      right: context.right.slice(0, NEAREST),
      moreLeft: Math.max(0, context.left.length - NEAREST),
      moreRight: Math.max(0, context.right.length - NEAREST),
    };
  });

  const degrees = (neighbour: Neighbour) => Math.round(Math.abs(neighbour.bearing));
</script>

{#snippet head()}
  {#if focus !== null}
    <Toolbar ariaLabel={t('focus.label')}>
      <Text>{t('focus.title', { label: focus.label })}</Text>
      {#snippet end()}
        <IconButton
          handle={handleOf`page.focus.close`}
          icon="pane-unzoom"
          label={t('focus.close')}
          size="small"
          onpress={() => {
            void model.run('reference.focus.exit', {});
          }}
        />
      {/snippet}
    </Toolbar>
  {/if}
{/snippet}

{#snippet foot()}
  {#if focus !== null}
    <Toolbar ariaLabel={t('focus.context')}>
      {#if focus.left.length === 0 && focus.right.length === 0}
        <Text quiet>{t('focus.alone')}</Text>
      {/if}
      {#if focus.moreLeft > 0}
        <Button
          handle={handleOf`page.focus.step.left`}
          label={t('focus.more.left', { count: focus.moreLeft })}
          size="small"
          variant="ghost"
          onpress={() => {
            void model.run('reference.focus.step', { direction: 'left' });
          }}
        />
      {/if}
      {#each focus.left as neighbour (neighbour.id)}
        <Button
          handle={keyed('page.focus.context', neighbour.id)}
          label={t('focus.left', { label: neighbour.label, degrees: degrees(neighbour) })}
          size="small"
          onpress={() => {
            void model.run('reference.focus.enter', { id: neighbour.id });
          }}
        />
      {/each}
      {#each focus.right as neighbour (neighbour.id)}
        <Button
          handle={keyed('page.focus.context', neighbour.id)}
          label={t('focus.right', { label: neighbour.label, degrees: degrees(neighbour) })}
          size="small"
          onpress={() => {
            void model.run('reference.focus.enter', { id: neighbour.id });
          }}
        />
      {/each}
      {#if focus.moreRight > 0}
        <Button
          handle={handleOf`page.focus.step.right`}
          label={t('focus.more.right', { count: focus.moreRight })}
          size="small"
          variant="ghost"
          onpress={() => {
            void model.run('reference.focus.step', { direction: 'right' });
          }}
        />
      {/if}
    </Toolbar>
  {/if}
{/snippet}

<Stack fill gap="small">
  {#if model.startProblem !== null}
    <Notice tone="danger" title={model.startProblem} handle={handleOf`page.panorama.problem`} />
  {/if}
  {#if model.refusal !== null && !model.isSceneRefusal(model.refusal)}
    <Notice tone="danger" title={model.refusalText(model.refusal)} handle={handleOf`page.panorama.refusal`} />
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
    <ScaledView ariaLabel={t('view.label')} handle={handleOf`page.panorama`} {head} {foot} bind:surface />
  </Stack>
</Stack>
