<script lang="ts">
  // THE MAP: the workspace from above, drawn on the kit's stage, with the selected window's
  // placement beside it. Its position across and ahead is where the map puts it; its height,
  // which a map from above cannot show, is a field of its own. Every change is a scene
  // transaction, so every view shows the window where it now is.
  import type { StageUnit } from '@wsb/uikit/components';
  import { Button, EmptyState, Facts, Field, Input, Stack, Stage, Text } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { onDestroy } from 'svelte';
  import { VIEWPORT_ID } from '../app.js';
  import type { MapView } from '../map.js';
  import { MAP_SCALE, mapScene } from '../map.js';
  import type { MessageId } from '../messages.js';
  import { MapDrawer } from './map-drawer.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);
  const round = (value: number) => Number(value.toFixed(2));

  let viewport: HTMLElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let units = $state<StageUnit[]>([]);
  let view = $state<MapView | null>(null);
  let drawer: MapDrawer | null = null;
  /** The drawer is drawing. */
  let ready = $state(false);
  /** A field whose text is not a number, by its name, until it is set again. */
  let invalid = $state<'x' | 'y' | 'z' | null>(null);

  $effect(() => {
    const app = model.app;
    if (app === null || viewport === undefined || canvas === undefined || drawer !== null) {
      return;
    }
    drawer = new MapDrawer({
      app,
      messages: model.messages,
      viewport,
      canvas,
      onunits: (next) => {
        units = next;
      },
      onview: (next) => {
        view = next;
      },
      onselect: (id) => {
        void model.select(id);
      },
    });
    view = drawer.view;
    ready = true;
  });
  onDestroy(() => {
    drawer?.dispose();
    drawer = null;
  });

  // Asked to show a window: centre on it, once for each time it is asked.
  let answered = 0;
  $effect(() => {
    const request = model.mapRequest;
    if (request !== null && ready && request.count !== answered) {
      answered = request.count;
      drawer?.centreOnWindow(request.id);
    }
  });

  const marker = $derived.by(() => {
    void model.revision;
    const app = model.app;
    const id = model.selected?.id;
    if (app === null || id === undefined) {
      return null;
    }
    return mapScene(app.workspace.getState(), VIEWPORT_ID).markers.find((m) => m.id === id) ?? null;
  });

  function place(axis: 'x' | 'y' | 'z', text: string): void {
    const value = Number(text.trim());
    if (marker === null) {
      return;
    }
    if (text.trim() === '' || !Number.isFinite(value)) {
      invalid = axis;
      return;
    }
    invalid = null;
    const at =
      axis === 'y'
        ? { y: value }
        : axis === 'x'
          ? { x: value, z: marker.z }
          : { x: marker.x, z: value };
    void model.run('reference.window.place', { id: marker.id, ...at });
  }
</script>

{#snippet aside()}
  <Stack inset gap="medium">
    <Stack direction="row" gap="small" wrap>
      <Button
        handle={handleOf`page.map.zoom-in`}
        label={t('map.zoom.in')}
        size="small"
        disabled={view === null || view.scale >= MAP_SCALE.max}
        onpress={() => {
          drawer?.zoomBy(MAP_SCALE.step);
        }}
      />
      <Button
        handle={handleOf`page.map.zoom-out`}
        label={t('map.zoom.out')}
        size="small"
        disabled={view === null || view.scale <= MAP_SCALE.min}
        onpress={() => {
          drawer?.zoomBy(1 / MAP_SCALE.step);
        }}
      />
      <Button
        handle={handleOf`page.map.recentre`}
        label={t('map.recentre')}
        size="small"
        onpress={() => {
          drawer?.centreOn(0, 0);
        }}
      />
    </Stack>
    {#if view !== null}
      <Text quiet>{t('map.scale', { value: round(view.scale) })}</Text>
    {/if}
    {#if marker === null}
      <EmptyState icon="pin" title={t('map.none')} detail={t('map.none.detail')} />
    {:else}
      <Facts
        ariaLabel={t('map.placement')}
        items={[
          { term: t('inspector.name'), value: marker.label },
          {
            term: t('map.camera'),
            value: t(marker.side === 'front' ? 'map.side.front' : 'map.side.behind'),
          },
        ]}
      />
      {#key `${marker.id}:${String(marker.x)}:${String(marker.y)}:${String(marker.z)}`}
        <Field
          label={t('map.x')}
          for="reference-map-x"
          message={invalid === 'x' ? t('map.number.invalid') : undefined}
          messageTone="danger"
        >
          {#snippet control()}
            <Input
              handle={handleOf`page.map.x`}
              id="reference-map-x"
              type="number"
              step={0.1}
              value={String(round(marker.x))}
              invalid={invalid === 'x'}
              onchange={(text) => {
                place('x', text);
              }}
            />
          {/snippet}
        </Field>
        <Field
          label={t('map.z')}
          for="reference-map-z"
          message={invalid === 'z' ? t('map.number.invalid') : undefined}
          messageTone="danger"
        >
          {#snippet control()}
            <Input
              handle={handleOf`page.map.z`}
              id="reference-map-z"
              type="number"
              step={0.1}
              value={String(round(marker.z))}
              invalid={invalid === 'z'}
              onchange={(text) => {
                place('z', text);
              }}
            />
          {/snippet}
        </Field>
        <Field
          label={t('map.height')}
          for="reference-map-y"
          hint={t('map.height.hint')}
          message={invalid === 'y' ? t('map.number.invalid') : undefined}
          messageTone="danger"
        >
          {#snippet control()}
            <Input
              handle={handleOf`page.map.height`}
              id="reference-map-y"
              type="number"
              step={0.1}
              value={String(round(marker.y))}
              invalid={invalid === 'y'}
              onchange={(text) => {
                place('y', text);
              }}
            />
          {/snippet}
        </Field>
      {/key}
    {/if}
  </Stack>
{/snippet}

<Stage
  handle={handleOf`page.map`}
  ariaLabel={t('map.label')}
  help={t('map.help')}
  {units}
  {aside}
  asideLabel={t('map.placement')}
  bind:viewport
  bind:canvas
/>
