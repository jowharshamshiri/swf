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
  import type { SnapConstraint } from '../magnetic.js';
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
    const element = surface;
    void model.start(element);
    // Whether the panorama itself has the keyboard, so its keys can be shown where hints are.
    const follow = () => {
      model.panoramaFocused = element.ownerDocument.activeElement === element;
    };
    element.addEventListener('focusin', follow);
    element.addEventListener('focusout', follow);
    return () => {
      element.removeEventListener('focusin', follow);
      element.removeEventListener('focusout', follow);
      model.panoramaFocused = false;
    };
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

  /**
   * Gestures that change the scene: each shows its preview, its snap, its cancel and its end. A
   * window held from the keyboard (`gesture.grab`) is one too.
   */
  const MODIFYING = ['node.move', 'node.resize', 'orbit.turn', 'gesture.grab'];

  const labelOf = (id: string | null) => {
    void model.revision;
    const node = id === null ? undefined : model.app?.workspace.getState().nodes.get(id);
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
    const snapping = model.policies?.features.enabled.snap === true && gesture.operation === 'node.move';
    return {
      what,
      held,
      detail: held
        ? t('panorama.held.keys')
        : gesture.snap !== null && gesture.snap.constraints.length > 0
          ? snapText(gesture.snap.constraints)
          : snapping
            ? t('gesture.free')
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

  // A restore that failed (the workspace saved last, a named one, a file), until dismissed.
  let dismissedRestore = $state<unknown>(null);
  const restoreProblem = $derived.by(() => {
    const error = model.workspaces?.restoreError ?? null;
    return error === null || error === dismissedRestore ? null : error;
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
  {#if restoreProblem !== null}
    <Toolbar ariaLabel={t('restore.failed', { reason: restoreProblem.message })}>
      <Text>{t('restore.failed', { reason: restoreProblem.message })}</Text>
      {#snippet end()}
        <IconButton
          handle={handleOf`page.restore.dismiss`}
          icon="close"
          label={t('notice.dismiss')}
          size="small"
          onpress={() => {
            dismissedRestore = restoreProblem;
          }}
        />
      {/snippet}
    </Toolbar>
  {/if}
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
  {#if running !== null}
    <Toolbar ariaLabel={t('gesture.label')}>
      <Text>{running.what}</Text>
      <Text quiet>{running.detail}</Text>
      {#snippet end()}
        {#if running.held}
          <Button
            handle={handleOf`page.gesture.drop`}
            label={t('gesture.drop')}
            size="small"
            variant="primary"
            onpress={() => {
              void model.run('reference.gesture.drop', {});
            }}
          />
        {/if}
        <Button
          handle={handleOf`page.gesture.cancel`}
          label={t('gesture.cancel')}
          size="small"
          onpress={() => {
            void model.run('reference.gesture.cancel', {});
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
              void model.run('reference.history.undo', {});
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
  {/if}
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
  {#if model.refusal !== null && !model.isSceneRefusal(model.refusal) && !model.isFeatureRefusal(model.refusal) && !model.isWorkspaceRefusal(model.refusal) && !model.isInspectorRefusal(model.refusal)}
    <Notice tone="danger" title={model.refusalText(model.refusal)} handle={handleOf`page.panorama.refusal`} />
  {/if}
  {#if model.keyRefusal !== null}
    <Notice tone="danger" title={model.keyRefusal} handle={handleOf`page.panorama.keys.refusal`} />
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
