<script lang="ts">
  // EVERY WINDOW, FOUND BY WHAT THE WORKSPACE SAYS OF IT: its name, tags, the colour the host
  // exposes, the groups it is in. Typing searches once it pauses; filters and a sort narrow and
  // order the list; the list draws only the rows in view, reading the results a page at a time,
  // so a scene of hundreds is all there and none of it is cut off. Pressing a row selects the
  // window; its actions focus it, reveal it in the panorama, show it in the map or inspect it,
  // and none of them moves it. Opening a row (a double press, or Enter) reveals it.
  import {
    Button,
    EmptyState,
    Field,
    IconButton,
    ListItem,
    Pane,
    Search,
    Select,
    Stack,
    Text,
    VirtualList,
  } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import type { MessageId } from '../messages.js';
  import type { SearchFilters, SearchResult, SortKey } from '@swf/navigation';
  import { ATTACHMENT_FILTERS, COVERAGE_FILTERS, LOCK_FILTERS, NO_FILTERS, PAGE_SIZE, SORT_KEYS, VISIBILITY_FILTERS } from '@swf/navigation';
  import type { ShellModel } from './model.svelte.js';
  import { WindowActions } from '@swf/navigation-ui';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  let filtersOpen = $state(false);

  // Read again whenever the query or the results change.
  const view = $derived.by(() => {
    void model.searchVersion;
    const search = model.app?.search;
    if (search === undefined) {
      return null;
    }
    return {
      search,
      query: search.query(),
      typed: search.typed(),
      pending: search.pending(),
      ids: search.ids(),
      groups: search.groups(),
    };
  });
  const filtered = $derived(
    view !== null && JSON.stringify(view.query.filters) !== JSON.stringify(NO_FILTERS),
  );

  /** The result at an index, read from its page. */
  function resultAt(index: number): SearchResult {
    if (view === null) {
      throw new Error('no search');
    }
    const row = view.search.page(Math.floor(index / PAGE_SIZE))[index % PAGE_SIZE];
    if (row === undefined) {
      throw new Error(`no result at ${String(index)}`);
    }
    return row;
  }

  /**
   * Where a window stands, in words: the list says what the panorama shows, so it stands in for
   * the panorama for whoever cannot see it (UX-013, NFR-024).
   */
  const whereOf = (id: string): string | null => {
    void model.revision;
    const pose = model.app?.poseOf(id) ?? null;
    return pose === null ? null : model.where(pose);
  };

  const setFilter = (filters: Partial<SearchFilters>) => {
    view?.search.setFilters(filters);
  };
  const options = <T extends string>(values: readonly T[], prefix: string) =>
    values.map((value) => ({ value, label: t(`${prefix}.${value}` as MessageId) }));
</script>

{#snippet row(index: number)}
  {@const result = resultAt(index)}
  {@const where = whereOf(result.id)}
  {#snippet actions()}
    <WindowActions {model} id={result.id} handle="page.windows.row" toggle />
  {/snippet}
  <ListItem
    handle={keyed('page.windows.window', result.id)}
    title={result.label}
    detail={[
      result.id,
      ...(where === null ? [] : [where]),
      ...(result.groups.length === 0 ? [] : [t('search.in.groups', { groups: result.groups.join(' / ') })]),
    ].join(' · ')}
    icon="document"
    selected={model.selected?.id === result.id}
    {actions}
    onpress={() => {
      void model.select(result.id);
    }}
    onopen={() => {
      void model.run('swf.window.reveal', { id: result.id });
    }}
  />
{/snippet}

{#snippet filter()}
  {#if view !== null}
    <Stack gap="small">
      <Search
        handle={handleOf`page.windows.search`}
        id="reference-search"
        value={view.typed}
        placeholder={t('search.placeholder')}
        oninput={(text) => {
          view.search.setText(text);
        }}
      />
      <Stack direction="row" gap="small" align="center">
        <Stack grow>
          <Select
            handle={handleOf`page.windows.sort`}
            id="reference-sort"
            ariaLabel={t('search.sort')}
            options={options(SORT_KEYS, 'search.sort')}
            value={view.query.sort}
            onchange={(sort) => {
              view.search.setSort(sort as SortKey, view.query.descending);
            }}
          />
        </Stack>
        <IconButton
          handle={handleOf`page.windows.reverse`}
          icon={view.query.descending ? 'chevron-up' : 'chevron-down'}
          label={t('search.reverse')}
          size="small"
          pressed={view.query.descending}
          onpress={() => {
            view.search.setSort(view.query.sort, !view.query.descending);
          }}
        />
        <IconButton
          handle={handleOf`page.windows.filters`}
          icon="filter"
          label={t('search.filters')}
          size="small"
          pressed={filtersOpen}
          indicator={filtered ? t('search.filters') : undefined}
          onpress={() => {
            filtersOpen = !filtersOpen;
          }}
        />
      </Stack>
      {#if filtersOpen}
        <Field label={t('search.group')} for="reference-filter-group">
          {#snippet control()}
            <Select
              handle={handleOf`page.windows.filter.group`}
              id="reference-filter-group"
              options={[
                { value: '', label: t('search.group.any') },
                ...view.groups.map((group) => ({ value: group.id, label: group.label })),
              ]}
              value={view.query.filters.group ?? ''}
              onchange={(group) => {
                setFilter({ group: group === '' ? null : group });
              }}
            />
          {/snippet}
        </Field>
        <Field label={t('search.visibility')} for="reference-filter-visibility">
          {#snippet control()}
            <Select
              handle={handleOf`page.windows.filter.visibility`}
              id="reference-filter-visibility"
              options={options(VISIBILITY_FILTERS, 'search.visibility')}
              value={view.query.filters.visibility}
              onchange={(visibility) => {
                setFilter({ visibility: visibility as SearchFilters['visibility'] });
              }}
            />
          {/snippet}
        </Field>
        <Field label={t('search.lock')} for="reference-filter-lock">
          {#snippet control()}
            <Select
              handle={handleOf`page.windows.filter.lock`}
              id="reference-filter-lock"
              options={options(LOCK_FILTERS, 'search.lock')}
              value={view.query.filters.lock}
              onchange={(lock) => {
                setFilter({ lock: lock as SearchFilters['lock'] });
              }}
            />
          {/snippet}
        </Field>
        <Field label={t('search.attachment')} for="reference-filter-attachment">
          {#snippet control()}
            <Select
              handle={handleOf`page.windows.filter.attachment`}
              id="reference-filter-attachment"
              options={options(ATTACHMENT_FILTERS, 'search.attachment')}
              value={view.query.filters.attachment}
              onchange={(attachment) => {
                setFilter({ attachment: attachment as SearchFilters['attachment'] });
              }}
            />
          {/snippet}
        </Field>
        <Field label={t('search.coverage')} for="reference-filter-coverage">
          {#snippet control()}
            <Select
              handle={handleOf`page.windows.filter.coverage`}
              id="reference-filter-coverage"
              options={options(COVERAGE_FILTERS, 'search.coverage')}
              value={view.query.filters.coverage}
              onchange={(coverage) => {
                setFilter({ coverage: coverage as SearchFilters['coverage'] });
              }}
            />
          {/snippet}
        </Field>
        <Button
          handle={handleOf`page.windows.clear`}
          label={t('search.clear')}
          size="small"
          disabled={!filtered}
          onpress={() => {
            view.search.clearFilters();
          }}
        />
      {/if}
      <Text quiet>{view.pending ? t('search.pending') : t('search.count', { count: view.ids.length })}</Text>
    </Stack>
  {/if}
{/snippet}

{#snippet paneActions()}
  <!-- As a file explorer's New File: a new window, straight ahead of the camera. -->
  <IconButton
    handle={handleOf`page.windows.add`}
    icon="add"
    label={t('command.window.add')}
    size="small"
    disabled={model.app === null}
    onpress={() => {
      void model.run('reference.window.add', {});
    }}
  />
{/snippet}

<Pane
  title={t('windows.title')}
  handle={handleOf`page.windows`}
  fill={view !== null && view.ids.length > 0}
  {filter}
  actions={paneActions}
>
  {#if view !== null && view.ids.length === 0 && model.status !== null && model.status.windows > 0}
    <EmptyState icon="search" title={t('search.empty')} detail={t('search.empty.detail')}>
      {#snippet action()}
        <Stack direction="row" gap="small" justify="center">
          <Button
            handle={handleOf`page.windows.empty.clear`}
            label={t('search.clear')}
            disabled={!filtered}
            onpress={() => {
              view.search.clearFilters();
            }}
          />
          <Button
            handle={handleOf`page.windows.empty.reset`}
            label={t('search.reset')}
            variant="primary"
            onpress={() => {
              view.search.reset();
            }}
          />
        </Stack>
      {/snippet}
    </EmptyState>
  {:else if view !== null && view.ids.length === 0}
    <EmptyState icon="list" title={t('empty.title')} />
  {:else if view !== null}
    <VirtualList
      ariaLabel={t('search.results')}
      handle={handleOf`page.windows.results`}
      count={view.ids.length}
      key={(index) => view.ids[index] ?? String(index)}
      estimate={48}
      {row}
      selected={(index) => model.selected?.id === view.ids[index]}
    />
  {/if}
</Pane>
