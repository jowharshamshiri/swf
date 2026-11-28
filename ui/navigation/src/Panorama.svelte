<script lang="ts">
  // THE PANORAMA: the workspace presented in the surface the kit hands out, which the host makes
  // its navigation in. An empty workspace shows what the host gives to fill it. In focus, a bar
  // above names the focused window, steps to the next window and closes the focus; the windows
  // round it are in the strip below.
  import { Button, IconButton, Notice, ScaledView, Stack, Text, Toolbar } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import type { SnapConstraint } from '@swf/navigation';
  import { FOCUS_ID } from '@swf/navigation';
  import type { NavigationMessageId } from './messages.js';
  import type { NavigationModel } from './model.svelte.js';
  import { PANORAMA_PLACE } from './model.svelte.js';
  import { PanoramaGuides } from './panorama-guides.js';
  import ViewControls from './ViewControls.svelte';

  interface Props {
    model: NavigationModel;
    /**
     * Given once the element the panorama is presented in: the host makes its navigation there and
     * attaches it to the model, and the promise settles once it has (or could not).
     */
    onsurface: (surface: HTMLElement) => Promise<void>;
    /** The host's own notices, above the panorama. */
    notices?: Snippet;
    /** The host's own bars across the top of the panorama, under the view's controls. */
    bars?: Snippet;
    /** What the panorama shows while the workspace has no window: the host's way to fill it. */
    empty?: Snippet;
    /** The view's own controls above it: the package's unless the host gives its own; none with null. */
    controls?: Snippet | null | undefined;
  }

  let { model, onsurface, notices, bars, empty, controls }: Props = $props();
  const t = (id: NavigationMessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  let surface: HTMLElement | undefined = $state();

  onMount(() => {
    if (surface === undefined) {
      throw new Error('the panorama has no surface to present in');
    }
    const element = surface;
    // The guides under the windows: what lies behind the camera, and the seam.
    let guides: PanoramaGuides | null = null;
    let gone = false;
    void onsurface(element).then(() => {
      const app = model.navigation;
      if (app !== null && !gone) {
        guides = new PanoramaGuides({ app, messages: model.messages, container: element });
      }
    });
    // Whether the panorama itself has the keyboard, so its keys can be shown where hints are.
    const follow = () => {
      model.panoramaFocused = element.ownerDocument.activeElement === element;
    };
    element.addEventListener('focusin', follow);
    element.addEventListener('focusout', follow);
    // A double press on a window's title bar, frame or stand-in shows it in focus, and on the
    // window in focus closes the focus (its live content keeps its own presses: a double press
    // there selects a word, as anywhere else).
    const focusAt = (event: MouseEvent) => {
      const app = model.navigation;
      if (app === null || model.policies?.features.enabled.focus !== true) {
        return;
      }
      const box = element.getBoundingClientRect();
      const id = app.windowAt(event.clientX - box.left, event.clientY - box.top);
      if (id !== null) {
        void model.run('swf.focus.toggle', { id });
      }
    };
    element.addEventListener('dblclick', focusAt);
    return () => {
      element.removeEventListener('dblclick', focusAt);
      gone = true;
      guides?.dispose();
      guides = null;
      element.removeEventListener('focusin', follow);
      element.removeEventListener('focusout', follow);
      model.panoramaFocused = false;
    };
  });

  const focus = $derived.by(() => {
    void model.revision;
    const app = model.navigation;
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
      alone: context.left.length === 0 && context.right.length === 0,
    };
  });

  /**
   * Gestures that change the scene: each shows its preview, where the window would be as it goes,
   * its snap, its cancel and its end. A window held from the keyboard (`gesture.grab`) is one too.
   */
  const MODIFYING = ['node.move', 'node.resize', 'orbit.turn', 'gesture.grab'];

  /** Where the window a gesture works on would be now, read again on every frame drawn. */
  const readingOf = (operation: string, nodeId: string | null): string | null => {
    void model.frame;
    const pose = nodeId === null ? null : (model.navigation?.poseOf(nodeId) ?? null);
    if (pose === null) {
      return null;
    }
    const round = (value: number, digits: number) => Number(value.toFixed(digits));
    switch (operation) {
      case 'node.resize':
        return t('gesture.reading.size', { width: round(pose.width, 2), height: round(pose.height, 2) });
      case 'node.move':
      case 'gesture.grab':
        return model.where(pose);
      default:
        return null;
    }
  };

  const labelOf = (id: string | null) => {
    void model.revision;
    const node = id === null ? undefined : model.navigation?.workspace.getState().nodes.get(id);
    return node?.label ?? id ?? '';
  };

  const constraintText = (c: SnapConstraint): string => {
    switch (c.kind) {
      case 'edge':
        return t(`snap.edge.${c.side}`, { label: c.neighbourLabel });
      case 'align':
        return t(`snap.align.${c.axis}`, { label: c.neighbourLabel });
      case 'horizon':
        return t('snap.horizon');
      case 'spoke':
        return t('snap.spoke.at', { degrees: Math.round(c.degrees) });
      case 'ring':
        return t('snap.ring.at', { distance: Number(c.distance.toFixed(2)) });
    }
  };
  const snapText = (constraints: readonly SnapConstraint[]) =>
    t('gesture.snapped', { constraints: constraints.map(constraintText).join(', ') });

  const running = $derived.by(() => {
    const gesture = model.policies?.gesture ?? null;
    if (gesture === null || !MODIFYING.includes(gesture.operation)) {
      return null;
    }
    const label = labelOf(gesture.nodeId);
    const held = gesture.operation === 'gesture.grab';
    const what =
      gesture.operation === 'node.move'
        ? t('gesture.node.move', { label })
        : gesture.operation === 'node.resize'
          ? t('gesture.node.resize', { label })
          : held
            ? t('gesture.gesture.grab', { label })
            : t('gesture.orbit.turn');
    const snapping = gesture.snaps;
    return {
      what,
      held,
      reading: readingOf(gesture.operation, gesture.nodeId),
      detail: held
        ? t('panorama.held.keys')
        : gesture.snap !== null && gesture.snap.constraints.length > 0
          ? snapText(gesture.snap.constraints)
          : snapping
            ? t('gesture.free')
            : gesture.wheel
              ? t('gesture.preview.wheel')
              : t('gesture.preview'),
    };
  });

  // The last gesture's end, until dismissed or another starts.
  let dismissed = $state<unknown>(null);
  const ended = $derived.by(() => {
    const last = model.policies?.ended ?? null;
    if (last === null || last === dismissed || !MODIFYING.includes(last.operation) || running !== null) {
      return null;
    }
    if (last.outcome === 'unchanged') {
      return null;
    }
    const label = labelOf(last.nodeId);
    const done =
      last.operation === 'node.move'
        ? t('gesture.done.node.move', { label })
        : last.operation === 'node.resize'
          ? t('gesture.done.node.resize', { label })
          : last.operation === 'gesture.grab'
            ? t('gesture.done.gesture.grab', { label })
            : t('gesture.done.orbit.turn');
    return {
      last,
      committed: last.outcome === 'committed',
      text:
        last.outcome === 'committed'
          ? last.snap !== null && last.snap.constraints.length > 0
            ? `${done}. ${snapText(last.snap.constraints)}`
            : done
          : t('gesture.cancelled'),
    };
  });

  const orbitGroup = $derived.by(() => {
    const policies = model.policies;
    if (policies === null || policies.orbit.navigation !== 'orbit') {
      return null;
    }
    return labelOf(policies.orbit.rootId);
  });
</script>

{#snippet head()}
  {#if controls === undefined}
    <ViewControls {model} />
  {:else if controls !== null}
    {@render controls()}
  {/if}
  {@render bars?.()}
  {#if model.removal !== null}
    <Toolbar ariaLabel={t('command.window.remove')}>
      <Text>{t('removed.text', { label: model.removal.label })}</Text>
      {#snippet end()}
        <Button
          handle={handleOf`page.removed.undo`}
          label={t('command.history.undo')}
          icon="undo"
          size="small"
          onpress={() => {
            void model.undoRemoval();
          }}
        />
        <IconButton
          handle={handleOf`page.removed.dismiss`}
          icon="close"
          label={t('notice.dismiss')}
          size="small"
          onpress={() => {
            model.dismissRemoval();
          }}
        />
      {/snippet}
    </Toolbar>
  {/if}
  {#if orbitGroup !== null}
    <Notice
      tone="info"
      title={t('orbit.announce.orbit', { group: orbitGroup })}
      handle={handleOf`page.panorama.navigation`}
    />
  {/if}
  {#if running === null && model.outcome !== null}
    {@const outcome = model.outcome}
    <!-- What the last quick action did, with undo while undo takes back that and nothing later. -->
    <Toolbar ariaLabel={t('outcome.label')}>
      <Text>{outcome.text}</Text>
      {#snippet end()}
        {#if outcome.transactionId !== null && model.history.undo}
          <Button
            handle={handleOf`page.outcome.undo`}
            label={t('command.history.undo')}
            icon="undo"
            size="small"
            onpress={() => {
              model.dismissOutcome();
              void model.run('swf.history.undo', {});
            }}
          />
        {/if}
        <IconButton
          handle={handleOf`page.outcome.dismiss`}
          icon="close"
          label={t('notice.dismiss')}
          size="small"
          onpress={() => {
            model.dismissOutcome();
          }}
        />
      {/snippet}
    </Toolbar>
  {/if}
  {#if running !== null}
    <Toolbar ariaLabel={t('gesture.label')}>
      <Text>{running.what}</Text>
      {#if running.reading !== null}
        <Text>{running.reading}</Text>
      {/if}
      <Text quiet>{running.detail}</Text>
      {#snippet end()}
        {#if running.held}
          <Button
            handle={handleOf`page.gesture.drop`}
            label={t('gesture.drop')}
            size="small"
            variant="primary"
            onpress={() => {
              void model.run('swf.gesture.drop', {});
            }}
          />
        {/if}
        <Button
          handle={handleOf`page.gesture.cancel`}
          label={t('gesture.cancel')}
          size="small"
          onpress={() => {
            void model.run('swf.gesture.cancel', {});
          }}
        />
      {/snippet}
    </Toolbar>
  {:else if ended !== null}
    <Toolbar ariaLabel={t('gesture.label')}>
      <Text>{ended.text}</Text>
      {#snippet end()}
        {#if ended.committed && model.history.undo}
          <Button
            handle={handleOf`page.gesture.undo`}
            label={t('command.history.undo')}
            icon="undo"
            size="small"
            onpress={() => {
              dismissed = ended.last;
              void model.run('swf.history.undo', {});
            }}
          />
        {/if}
        <IconButton
          handle={handleOf`page.gesture.dismiss`}
          icon="close"
          label={t('gesture.dismiss')}
          size="small"
          onpress={() => {
            dismissed = ended.last;
          }}
        />
      {/snippet}
    </Toolbar>
  {:else if focus === null}
    <!-- The gesture bar stays, saying how windows are handled, so a gesture starting never moves
         the panorama under the pointer. -->
    <Toolbar ariaLabel={t('gesture.label')}>
      <Text quiet>{t('gesture.help')}</Text>
      {#snippet end()}
        <Button
          handle={handleOf`page.gesture.idle.undo`}
          label={t('command.history.undo')}
          icon="undo"
          size="small"
          disabled={!model.history.undo}
          onpress={() => {
            void model.run('swf.history.undo', {});
          }}
        />
      {/snippet}
    </Toolbar>
  {/if}
  {#if focus !== null}
    <Toolbar ariaLabel={t('focus.label')}>
      <Text>{t('focus.title', { label: focus.label })}</Text>
      {#snippet end()}
        {#if !focus.alone}
          <Button
            handle={handleOf`page.focus.next`}
            label={t('focus.next')}
            icon="chevron-right"
            size="small"
            onpress={() => {
              void model.run('swf.focus.step', { direction: 'right' });
            }}
          />
        {/if}
        <IconButton
          handle={handleOf`page.focus.close`}
          icon="pane-unzoom"
          label={t('focus.close')}
          size="small"
          onpress={() => {
            void model.run('swf.focus.exit', {});
          }}
        />
      {/snippet}
    </Toolbar>
  {/if}
{/snippet}

<Stack fill gap="small">
  {@render notices?.()}
  {#if model.refusal !== null && model.placeOf(model.refusal) === PANORAMA_PLACE}
    <Notice tone="danger" title={model.refusalText(model.refusal)} handle={handleOf`page.panorama.refusal`} />
  {/if}
  {#if model.keyRefusal !== null}
    <Notice tone="danger" title={model.keyRefusal} handle={handleOf`page.panorama.keys.refusal`} />
  {/if}
  {#if model.status !== null && model.status.windows === 0}
    {@render empty?.()}
  {/if}
  <Stack grow>
    <ScaledView ariaLabel={t('view.label')} handle={handleOf`page.panorama`} {head} bind:surface />
  </Stack>
</Stack>
