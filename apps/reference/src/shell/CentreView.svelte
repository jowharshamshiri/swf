<script lang="ts">
  // THE CENTRE, BY MODE. The panorama is always presented, in the same place on the page, so a
  // switch of mode never attaches or detaches a window's content. In the panorama and in focus it
  // fills the centre. The map and the overview take the top of it, over the panorama as a band
  // below with a movable edge between them: what is done on the map is seen in the panorama at
  // once, and the overview is never a scene of its own.
  import { Tiling } from '@wsb/uikit/components';
  import type { TilingNode, TilingTile } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { MAP, OVERVIEW } from '../modes.js';
  import type { MessageId } from '../messages.js';
  import MapView from './MapView.svelte';
  import type { ShellModel } from './model.svelte.js';
  import OverviewView from './OverviewView.svelte';
  import PanoramaView from './PanoramaView.svelte';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId) => model.messages.format(id);

  /** The centre's height in rows: the edge between the halves moves a row at a time. */
  const ROWS = 100;
  const LEAST = 20;
  /** Rows the map or the overview takes above the edge. */
  let above = $state(64);

  const mode = $derived(model.status?.mode ?? null);
  const beside = $derived(mode === MAP.id || mode === OVERVIEW.id);
  const root = $derived<TilingNode>({
    split: {
      direction: 'vertical',
      left: 0,
      top: 0,
      cols: 1,
      rows: ROWS,
      first: { tile: { id: 'beside', left: 0, top: 0, cols: 1, rows: above } },
      second: { tile: { id: 'panorama', left: 0, top: above + 1, cols: 1, rows: ROWS - above - 1 } },
    },
  });
</script>

{#snippet tile(each: TilingTile)}
  {#if each.id === 'panorama'}
    <PanoramaView {model} />
  {:else if mode === MAP.id}
    <MapView {model} />
  {:else if mode === OVERVIEW.id}
    <OverviewView {model} />
  {/if}
{/snippet}

<Tiling
  handle={handleOf`page.centre`}
  label={t('view.label')}
  cols={1}
  rows={ROWS}
  {root}
  active={beside ? 'beside' : 'panorama'}
  zoomed={beside ? null : 'panorama'}
  {tile}
  onresize={(_, first) => {
    above = Math.min(ROWS - LEAST - 1, Math.max(LEAST, first));
  }}
/>
