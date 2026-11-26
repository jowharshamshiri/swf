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
  import type { Snippet } from 'svelte';
  import { FOCUS_ID, MAP, OVERVIEW } from '@swf/navigation';
  import type { NavigationMessageId } from './messages.js';
  import MapView from './MapView.svelte';
  import type { NavigationModel } from './model.svelte.js';
  import FocusStrip from './FocusStrip.svelte';
  import Overview from './Overview.svelte';

  interface Props {
    model: NavigationModel;
    /** The panorama, as the host shows it: the package's `Panorama`, given the host's surface. */
    panorama: Snippet;
    /** Under the focused window: the package's focus strip unless the host gives its own; none with null. */
    strip?: Snippet | null | undefined;
    /** Over the panorama in the map mode: the package's map unless the host gives its own; none with null. */
    map?: Snippet | null | undefined;
    /** Over the panorama in the overview: the package's overview unless the host gives its own; none with null. */
    overview?: Snippet | null | undefined;
  }

  let { model, panorama, strip, map, overview }: Props = $props();
  const t = (id: NavigationMessageId) => model.messages.format(id);

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
  // A part the host leaves out (null) leaves the panorama the whole centre in its mode.
  const beside = $derived(
    (mode === MAP.id && map !== null) || (mode === OVERVIEW.id && overview !== null),
  );
  const focused = $derived(mode === FOCUS_ID && strip !== null);
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
    {@render panorama()}
  {:else if each.id === 'strip'}
    {#if strip === undefined}
      <FocusStrip {model} />
    {:else if strip !== null}
      {@render strip()}
    {/if}
  {:else if mode === MAP.id}
    {#if map === undefined}
      <MapView {model} />
    {:else if map !== null}
      {@render map()}
    {/if}
  {:else if mode === OVERVIEW.id}
    {#if overview === undefined}
      <Overview {model} />
    {:else if overview !== null}
      {@render overview()}
    {/if}
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
