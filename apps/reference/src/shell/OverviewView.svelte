<script lang="ts">
  // THE OVERVIEW: every window the search finds, as a tile, a page of them at a time with the
  // rest a press away, never cut off. It is not another scene: a tile is the window's own ID, so
  // pressing one selects that window wherever it is shown, and opening one (a double press, or
  // Enter) focuses it. The selected window's actions stand at the head.
  import { Dock, List, ListItem, NextPage, Pane, Tag } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import type { MessageId } from '../messages.js';
  import { PAGE_SIZE } from '../search.js';
  import type { SearchResult } from '../search.js';
  import type { ShellModel } from './model.svelte.js';
  import WindowActions from './WindowActions.svelte';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  /** How many pages are shown. */
  let pages = $state(1);

  const found = $derived.by(() => {
    void model.searchVersion;
    const search = model.app?.search;
    if (search === undefined) {
      return { count: 0, tiles: [] as SearchResult[] };
    }
    const count = search.ids().length;
    const shown = Math.min(pages, search.pageCount());
    const tiles = Array.from({ length: shown }, (_, page) => search.page(page)).flat();
    return { count, tiles };
  });
  const selected = $derived(model.selected?.id ?? null);
  const focused = $derived.by(() => {
    void model.revision;
    return model.app?.workspace.getState().focusedId ?? null;
  });
</script>

{#snippet actions()}
  {#if selected !== null}
    <WindowActions {model} id={selected} handle="page.overview.selected" />
  {/if}
{/snippet}

<Dock layout="wide">
  <Pane
    title={t('overview.label')}
    handle={handleOf`page.overview`}
    {actions}
    standing={t('overview.shown', { shown: found.tiles.length, count: found.count })}
    empty={found.count === 0 ? { icon: 'search', title: t('search.empty'), detail: t('search.empty.detail') } : null}
  >
    <List ariaLabel={t('overview.label')}>
      {#each found.tiles as tile (tile.id)}
        {#snippet meta()}
          {#if focused === tile.id}
            <Tag label={t('mode.focus')} tone="info" />
          {/if}
        {/snippet}
        <ListItem
          handle={keyed('page.overview.tile', tile.id)}
          title={tile.label}
          detail={tile.id}
          description={tile.groups.length === 0
            ? undefined
            : t('search.in.groups', { groups: tile.groups.join(' / ') })}
          icon="document"
          {meta}
          selected={selected === tile.id}
          onpress={() => {
            void model.select(tile.id);
          }}
          onopen={() => {
            void model.run('reference.focus.enter', { id: tile.id });
          }}
        />
      {/each}
    </List>
    {#if found.tiles.length < found.count}
      <NextPage
        handle={handleOf`page.overview.more`}
        label={t('overview.more', { count: Math.min(PAGE_SIZE, found.count - found.tiles.length) })}
        onmore={() => {
          pages += 1;
        }}
      />
    {/if}
  </Pane>
</Dock>
