<script lang="ts">
  // THE RADAR'S DRAWING: the workspace round the camera from above, on the kit's stage. It follows
  // the camera and fits every window inside its rim; a window pressed on it is selected, and one
  // dragged on it moves round the camera, behind it too, previewed in every view as it goes and
  // committed once when let go.
  import type { StageUnit } from '@wsb/uikit/components';
  import { Stage } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { onDestroy } from 'svelte';
  import type { MessageId } from '../messages.js';
  import { MapDrawer } from './map-drawer.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId) => model.messages.format(id);

  let viewport: HTMLElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let units = $state<StageUnit[]>([]);
  let drawer: MapDrawer | null = null;

  $effect(() => {
    const app = model.app;
    if (app === null || viewport === undefined || canvas === undefined || drawer !== null) {
      return;
    }
    drawer = new MapDrawer({
      kind: 'radar',
      app,
      messages: model.messages,
      viewport,
      canvas,
      onunits: (next) => {
        units = next;
      },
      onview: () => undefined,
      onselect: (id) => {
        void model.select(id);
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
/>
