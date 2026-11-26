<script lang="ts">
  // THE VIEW'S OWN CONTROLS, across the top of the panorama: how wide it looks (its field of view,
  // which zooms it), which way the camera faces (its heading), and how far the workspace is turned
  // about the camera. Each is the kit's slider with a number to type; the camera's heading and the
  // field of view are view state, never undone, while turning the workspace changes the scene: it
  // previews as the slider moves and is one undoable change when let go.
  import { Button, Notice, Slider, Stack, Text, Toolbar } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { VIEWPORT_ID } from '../app.js';
  import type { MessageId } from '../messages.js';
  import { FIELD_OF_VIEW, fieldOfViewOf } from '../modes.js';
  import { cameraHeading, orbitHeading } from '../orbit.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId) => model.messages.format(id);
  const DEGREES = 180 / Math.PI;

  /** The view as the controls show it: read again on every commit. */
  const view = $derived.by(() => {
    void model.revision;
    const app = model.app;
    if (app === null) {
      return null;
    }
    const state = app.workspace.getState();
    const record = state.viewports.get(VIEWPORT_ID);
    if (record === undefined) {
      return null;
    }
    const panoramic = app.modes.list().find((m) => m.id === record.mode)?.panoramic === true;
    const turned = orbitHeading(state);
    return {
      panoramic,
      fov: fieldOfViewOf(panoramic ? record.projection : app.modes.panorama()),
      heading: cameraHeading(state, VIEWPORT_ID) * DEGREES,
      turned: turned === null ? null : turned * DEGREES,
    };
  });
  const orbit = $derived(model.policies?.orbit ?? null);
  /** Why the workspace cannot be turned now, or null when it can. */
  const turnBlocked = $derived(
    orbit === null || !orbit.enabled
      ? t('view.workspace.off')
      : orbit.rootId === null || view?.turned == null
        ? t('view.workspace.noroot')
        : null,
  );
  const refusal = $derived(
    model.refusal !== null && model.isViewRefusal(model.refusal) ? model.refusal : null,
  );
</script>

{#if view !== null}
  <Toolbar ariaLabel={t('view.controls')}>
    <Stack direction="row" gap="large" align="start" grow wrap>
      <Stack grow gap="small">
        {#if view.fov < FIELD_OF_VIEW.min || view.fov > FIELD_OF_VIEW.max}
          <!-- A restored workspace may show the panorama wider or narrower than this control sets. -->
          <Text>{model.messages.format('view.fov.outside', { value: Number(view.fov.toFixed(1)) })}</Text>
          <Button
            handle={handleOf`page.view.fov.whole`}
            label={t('view.fov.whole')}
            size="small"
            onpress={() => {
              void model.run('reference.view.fov', { degrees: FIELD_OF_VIEW.max });
            }}
          />
        {:else}
          <Slider
            handle={handleOf`page.view.fov`}
            label={t('view.fov')}
            value={view.fov}
            min={FIELD_OF_VIEW.min}
            max={FIELD_OF_VIEW.max}
            unit="°"
            field
            disabled={!view.panoramic}
            oninput={(degrees) => {
              void model.run('reference.view.fov', { degrees });
            }}
          />
        {/if}
        {#if !view.panoramic}
          <Text quiet>{t('view.fov.focus')}</Text>
        {/if}
      </Stack>
      <Stack grow gap="small">
        <Slider
          handle={handleOf`page.view.heading`}
          label={t('view.heading')}
          value={view.heading}
          min={-180}
          max={180}
          unit="°"
          field
          oninput={(degrees) => {
            void model.run('reference.view.heading', { degrees });
          }}
        />
      </Stack>
      <Stack grow gap="small">
        <Slider
          handle={handleOf`page.view.workspace`}
          label={t('view.workspace')}
          value={view.turned ?? 0}
          min={-180}
          max={180}
          unit="°"
          field
          disabled={turnBlocked !== null}
          oninput={(degrees) => {
            void model.run('reference.orbit.turnTo', { degrees, preview: true });
          }}
          onchange={(degrees) => {
            void model.run('reference.orbit.turnTo', { degrees });
          }}
        />
        {#if turnBlocked !== null}
          <Text quiet>{turnBlocked}</Text>
        {/if}
      </Stack>
    </Stack>
  </Toolbar>
  {#if refusal !== null}
    <Notice tone="danger" title={model.refusalText(refusal)} handle={handleOf`page.view.refusal`} />
  {/if}
{/if}
