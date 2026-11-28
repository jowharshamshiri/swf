<script lang="ts">
  // THE RADAR'S DRAWING: the workspace round the camera from above, on the kit's stage. It follows
  // the camera and fits every window inside its rim; a window pressed on it is selected, and one
  // dragged on it moves round the camera, behind it too, previewed in every view as it goes and
  // committed once when let go.
  import type { StageUnit } from '@wsb/uikit/components';
  import { Stage } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { onDestroy } from 'svelte';
  import type { NavigationMessageId } from './messages.js';
  import { MapDrawer } from './map-drawer.js';
  import type { NavigationModel } from './model.svelte.js';

  interface Props {
    model: NavigationModel;
  }

  let { model }: Props = $props();
  const t = (id: NavigationMessageId) => model.messages.format(id);

  let viewport: HTMLElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let layer: HTMLElement | undefined = $state();
  let units = $state<StageUnit[]>([]);
  let drawer: MapDrawer | null = null;

  $effect(() => {
    const app = model.navigation;
    if (
      app === null ||
      viewport === undefined ||
      canvas === undefined ||
      layer === undefined ||
      drawer !== null
    ) {
      return;
    }
    drawer = new MapDrawer({
      kind: 'radar',
      app,
      messages: model.messages,
      viewport,
      canvas,
      layer,
      onunits: (next) => {
        units = next;
      },
      onview: () => undefined,
      onselect: (id) => {
        void model.select(id);
      },
      onopen: (id) => {
        void model.run('swf.focus.toggle', { id });
      },
    });
  });
  onDestroy(() => {
    drawer?.dispose();
    drawer = null;
  });
</script>

<Stage
  handle={handleOf`page.radar`}
  ariaLabel={t('radar.label')}
  help={t('radar.help')}
  {units}
  bind:viewport
  bind:canvas
  bind:layer
/>
