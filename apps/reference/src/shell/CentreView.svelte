<script lang="ts">
  // THE CENTRE, BY MODE. The panorama is always presented, in the same place on the page, so a
  // switch of mode never attaches or detaches a window's content. In the panorama it fills the
  // centre. In focus it holds the focused window, over the focus strip as a band below with a
  // movable edge between them: every other window, where it lies round the reader. The map and
  // the overview take the top of it, over the panorama as a band below: what is done on the map
  // is seen in the panorama at once, and the overview is never a scene of its own.
  import { Tiling } from '@wsb/uikit/components';
  import type { TilingNode, TilingTile } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { FOCUS_ID, MAP, OVERVIEW } from '@swf/navigation';
  import type { MessageId } from '../messages.js';
  import MapView from './MapView.svelte';
  import type { ShellModel } from './model.svelte.js';
  import FocusStrip from './FocusStrip.svelte';
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
  /** The fewest rows the focus strip takes: still tall enough to tell its windows apart. */
  const STRIP_LEAST = 12;
  /** Rows the map or the overview takes above the edge. */
  let above = $state(64);
  /** Rows the focus strip takes below the edge. */
  let below = $state(34);

  const mode = $derived(model.status?.mode ?? null);
  const beside = $derived(mode === MAP.id || mode === OVERVIEW.id);
  const focused = $derived(mode === FOCUS_ID);
  const root = $derived<TilingNode>(
    focused
      ? {
          split: {
            direction: 'vertical',
            left: 0,
            top: 0,
            cols: 1,
            rows: ROWS,
            first: { tile: { id: 'panorama', left: 0, top: 0, cols: 1, rows: ROWS - below - 1 } },
            second: { tile: { id: 'strip', left: 0, top: ROWS - below, cols: 1, rows: below } },
          },
        }
      : {
          split: {
            direction: 'vertical',
            left: 0,
            top: 0,
            cols: 1,
            rows: ROWS,
            first: { tile: { id: 'beside', left: 0, top: 0, cols: 1, rows: above } },
            second: {
              tile: { id: 'panorama', left: 0, top: above + 1, cols: 1, rows: ROWS - above - 1 },
            },
          },
        },
  );
</script>

{#snippet tile(each: TilingTile)}
  {#if each.id === 'panorama'}
    <PanoramaView {model} />
  {:else if each.id === 'strip'}
    <FocusStrip {model} />
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
  zoomed={beside || focused ? null : 'panorama'}
  {tile}
  onresize={(_, first) => {
    if (focused) {
      below = Math.min(ROWS - LEAST - 1, Math.max(STRIP_LEAST, ROWS - first - 1));
    } else {
      above = Math.min(ROWS - LEAST - 1, Math.max(LEAST, first));
    }
  }}
/>
