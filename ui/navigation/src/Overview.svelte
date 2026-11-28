<script lang="ts">
  // THE OVERVIEW: every window round the camera at once, as a card where it stands, on the kit's
  // stage; beside it, the windows the search finds, as a list. Both are the scene read as it is:
  // a card and a row are the window's own ID, so pressing either selects that window wherever it is
  // shown, and opening either (a double press, or Enter on a row) focuses it. The selected
  // window's actions (focus it, centre the view on it, bring it in front or send it behind, show it
  // in the map, inspect it) stand at the head of the list, and each row says where its window
  // stands, so the list stands in for the board for whoever cannot see it. The search fades the
  // cards it leaves out, and never takes a card off the board.
  import type { StageUnit } from '@wsb/uikit/components';
  import {
    List,
    ListItem,
    NextPage,
    Notice,
    Search,
    Stack,
    Stage,
    Tag,
    Text,
    Toolbar,
  } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import { onDestroy } from 'svelte';
  import type { OverviewLayout, SearchResult } from '@swf/navigation';
  import { NO_FILTERS, PAGE_SIZE, VIEWPORT_ID, overviewScene } from '@swf/navigation';
  import type { NavigationMessageId } from './messages.js';
  import type { NavigationModel } from './model.svelte.js';
  import { groupHue, OverviewDrawer } from './overview-drawer.js';
  import WindowActions from './WindowActions.svelte';

  interface Props {
    model: NavigationModel;
  }

  let { model }: Props = $props();
  const t = (id: NavigationMessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  let viewport: HTMLElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let units = $state<StageUnit[]>([]);
  let crowded = $state(false);
  let drawer: OverviewDrawer | null = $state(null);

  $effect(() => {
    const app = model.navigation;
    if (app === null || viewport === undefined || canvas === undefined || drawer !== null) {
      return;
    }
    drawer = new OverviewDrawer({
      app,
      messages: model.messages,
      viewport,
      canvas,
      onunits: (next) => {
        units = next;
      },
      onlayout: (layout: OverviewLayout) => {
        crowded = layout.kind === 'crowded';
      },
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

  /** How many pages of the list are shown. */
  let pages = $state(1);

  const found = $derived.by(() => {
    void model.searchVersion;
    const search = model.navigation?.search;
    if (search === undefined) {
      return null;
    }
    const query = search.query();
    const ids = search.ids();
    const shown = Math.min(pages, search.pageCount());
    const rows: SearchResult[] = Array.from({ length: shown }, (_, page) => search.page(page)).flat();
    return {
      search,
      typed: search.typed(),
      count: ids.length,
      // Null while the search asks for nothing: then no card is faded for it.
      narrowed:
        query.text.trim() !== '' || JSON.stringify(query.filters) !== JSON.stringify(NO_FILTERS)
          ? new Set(ids)
          : null,
      rows,
    };
  });
  $effect(() => {
    drawer?.setFound(found?.narrowed ?? null);
  });

  // The scene's groups, each in the colour its cards' strips are drawn in.
  const groups = $derived.by(() => {
    void model.revision;
    const app = model.navigation;
    return app === null ? [] : overviewScene(app.workspace.getState(), VIEWPORT_ID, app.windows.category).groups;
  });
  /** Where a window stands, in words: the list says what the board shows, for whoever cannot see it. */
  const whereOf = (id: string): string | null => {
    void model.revision;
    const pose = model.navigation?.poseOf(id) ?? null;
    return pose === null ? null : model.where(pose);
  };
  const windows = $derived(model.status?.windows ?? 0);
  const selected = $derived(model.selected?.id ?? null);
  const focused = $derived.by(() => {
    void model.revision;
    return model.navigation?.workspace.getState().focusedId ?? null;
  });
</script>

{#snippet aside()}
  <Stack gap="small" grow>
    <Toolbar ariaLabel={t('action.label')}>
      {#if selected !== null}
        <WindowActions {model} id={selected} handle="page.overview.selected" />
      {:else}
        <Text quiet>{t('overview.none')}</Text>
      {/if}
    </Toolbar>
    {#if found !== null}
      <Search
        handle={handleOf`page.overview.search`}
        id="swf-overview-search"
        value={found.typed}
        placeholder={t('search.placeholder')}
        oninput={(text) => {
          found.search.setText(text);
        }}
      />
    {/if}
    {#if groups.length > 0}
      <Stack direction="row" gap="small" wrap>
        {#each groups as group, i (group.id)}
          <Tag handle={keyed('page.overview.group', group.id)} label={group.label} colour={groupHue(i)} />
        {/each}
      </Stack>
    {/if}
    <Text quiet>{t('overview.shown', { shown: found?.rows.length ?? 0, count: found?.count ?? 0 })}</Text>
    {#if found !== null && found.count === 0}
      <Notice title={t('search.empty')} detail={t('search.empty.detail')} />
    {:else if found !== null}
      <List ariaLabel={t('overview.list')}>
        {#each found.rows as row (row.id)}
          {#snippet meta()}
            {#if focused === row.id}
              <Tag label={t('mode.focus')} tone="info" />
            {/if}
          {/snippet}
          <ListItem
            handle={keyed('page.overview.tile', row.id)}
            title={row.label}
            detail={[row.id, ...(whereOf(row.id) === null ? [] : [whereOf(row.id)])].join(' · ')}
            description={row.groups.length === 0
              ? undefined
              : t('search.in.groups', { groups: row.groups.join(' / ') })}
            icon="document"
            {meta}
            selected={selected === row.id}
            onpress={() => {
              void model.select(row.id);
            }}
            onopen={() => {
              void model.run('swf.focus.enter', { id: row.id });
            }}
          />
        {/each}
      </List>
      {#if found.rows.length < found.count}
        <NextPage
          handle={handleOf`page.overview.more`}
          label={t('overview.more', { count: Math.min(PAGE_SIZE, found.count - found.rows.length) })}
          onmore={() => {
            pages += 1;
          }}
        />
      {/if}
    {/if}
  </Stack>
{/snippet}

<Stack grow fill>
  {#if crowded}
    <Notice
      handle={handleOf`page.overview.crowded`}
      title={t('overview.crowded', { count: windows })}
      detail={t('overview.crowded.detail')}
    />
  {/if}
  <Stage
    handle={handleOf`page.overview.board`}
    ariaLabel={t('overview.label')}
    help={t('overview.help')}
    {units}
    {aside}
    asideLabel={t('overview.list')}
    bind:viewport
    bind:canvas
  />
</Stack>
