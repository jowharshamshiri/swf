<script lang="ts">
  // THE FOCUS STRIP: under a focused window, a card for every window, the focused one in the
  // middle and the others left and right of it in the order they lie round the reader, each as far
  // from the middle as it lies round where room allows, none over another: its name, and the
  // host's own picture of what it holds, live. Pressing a card focuses its window; with the
  // strip's keyboard stop, the arrows step to the next window either way. Above it the nearest
  // windows each way are named, with how far round they lie, each a press away, and the rest a
  // step away.
  import type { StageUnit } from '@wsb/uikit/components';
  import { Button, Stack, Stage, Text, Toolbar } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import { onDestroy } from 'svelte';
  import type { Neighbour } from '@swf/navigation';
  import type { MessageId } from '../messages.js';
  import type { ShellModel } from './model.svelte.js';
  import { StripDrawer } from './strip-drawer.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  /** Windows named each side of the focus; the rest are a step away. */
  const NEAREST = 2;

  let viewport: HTMLElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let layer: HTMLElement | undefined = $state();
  let units = $state<StageUnit[]>([]);
  /** The windows the strip has no room for, by name. */
  let hidden = $state<readonly string[]>([]);
  let drawer: StripDrawer | null = null;

  $effect(() => {
    const app = model.app;
    if (app === null || viewport === undefined || canvas === undefined || drawer !== null) {
      return;
    }
    const element = viewport;
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'application');
    element.setAttribute('aria-roledescription', t('focus.strip.role'));
    element.setAttribute('aria-label', t('focus.strip.label'));
    element.setAttribute('aria-description', `${t('focus.strip.hint')}. ${t('focus.strip.keys')}`);
    drawer = new StripDrawer({
      app,
      viewport: element,
      canvas,
      layer: () => layer,
      onunits: (next) => {
        units = next;
      },
      onhidden: (labels) => {
        hidden = labels;
      },
      onfocus: (id) => {
        void model.run('swf.focus.enter', { id });
      },
      onstep: (direction) => {
        void model.run('swf.focus.step', { direction });
      },
    });
  });
  onDestroy(() => {
    drawer?.dispose();
    drawer = null;
  });

  const around = $derived.by(() => {
    void model.revision;
    const context = model.app?.focusNeighbours() ?? null;
    if (context === null) {
      return null;
    }
    return {
      left: context.left.slice(0, NEAREST).reverse(),
      right: context.right.slice(0, NEAREST),
      moreLeft: Math.max(0, context.left.length - NEAREST),
      moreRight: Math.max(0, context.right.length - NEAREST),
    };
  });

  const degrees = (neighbour: Neighbour) => Math.round(Math.abs(neighbour.bearing));
</script>

<Stack fill gap="small">
  <Toolbar ariaLabel={t('focus.context')}>
    {#if around === null || (around.left.length === 0 && around.right.length === 0)}
      <Text quiet>{t('focus.alone')}</Text>
    {:else}
      {#if around.moreLeft > 0}
        <Button
          handle={handleOf`page.focus.step.left`}
          label={t('focus.more.left', { count: around.moreLeft })}
          size="small"
          variant="ghost"
          onpress={() => {
            void model.run('swf.focus.step', { direction: 'left' });
          }}
        />
      {/if}
      {#each around.left as neighbour (neighbour.id)}
        <Button
          handle={keyed('page.focus.context', neighbour.id)}
          label={t('focus.left', { label: neighbour.label, degrees: degrees(neighbour) })}
          size="small"
          onpress={() => {
            void model.run('swf.focus.enter', { id: neighbour.id });
          }}
        />
      {/each}
      {#each around.right as neighbour (neighbour.id)}
        <Button
          handle={keyed('page.focus.context', neighbour.id)}
          label={t('focus.right', { label: neighbour.label, degrees: degrees(neighbour) })}
          size="small"
          onpress={() => {
            void model.run('swf.focus.enter', { id: neighbour.id });
          }}
        />
      {/each}
      {#if around.moreRight > 0}
        <Button
          handle={handleOf`page.focus.step.right`}
          label={t('focus.more.right', { count: around.moreRight })}
          size="small"
          variant="ghost"
          onpress={() => {
            void model.run('swf.focus.step', { direction: 'right' });
          }}
        />
      {/if}
    {/if}
    {#if hidden.length > 0}
      <Text quiet>{t('focus.strip.hidden', { labels: hidden.join(', ') })}</Text>
    {/if}
  </Toolbar>
  <Stack grow>
    <Stage
      handle={handleOf`page.focus.strip`}
      ariaLabel={t('focus.strip.label')}
      help={t('focus.strip.hint')}
      {units}
      bind:viewport
      bind:canvas
      bind:layer
    />
  </Stack>
</Stack>
