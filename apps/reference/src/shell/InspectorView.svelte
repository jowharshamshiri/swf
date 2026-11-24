<script lang="ts">
  // WHAT IS SELECTED: the window's identity and where it is around the camera, in degrees and
  // world units, formatted for the reader's locale (the scene keeps its own numbers); the surfaces
  // the host supplied for it, each detached into a window of its own or moved into another window
  // whole, never split (FR-126, AC-016); merging it into another window and moving it into a group;
  // and removing it from the workspace, which says it does not delete or stop its content (UX-011).
  import {
    Button,
    EmptyState,
    Facts,
    Field,
    IconButton,
    Input,
    List,
    ListItem,
    Notice,
    Panel,
    Section,
    Select,
    Stack,
    Text,
  } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import type { MessageId } from '../messages.js';
  import { contentOf } from '../presets.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);
  const round = (value: number, digits: number) => Number(value.toFixed(digits));

  const selected = $derived(model.selected);
  const facts = $derived(
    selected === null
      ? []
      : [
          { term: t('inspector.id'), value: selected.id, literal: true },
          { term: t('inspector.name'), value: selected.label ?? selected.id },
          ...(selected.content === null
            ? []
            : [{ term: t('inspector.content'), value: t(`content.${selected.content}`) }]),
          {
            term: t('inspector.heading'),
            value: t('inspector.degrees', { value: round(selected.heading, 1) }),
          },
          {
            term: t('inspector.elevation'),
            value: t('inspector.degrees', { value: round(selected.elevation, 1) }),
          },
          {
            term: t('inspector.distance'),
            value: t('inspector.units', { value: round(selected.distance, 2) }),
          },
          {
            term: t('inspector.presentation'),
            value:
              selected.representation === 'compact' || selected.representation === 'label'
                ? t(`representation.${selected.representation}`)
                : t(`presentation.${selected.presentation}`),
          },
        ],
  );

  const composing = $derived(model.policies?.features.enabled.composition ?? false);

  // The selected window's surfaces, the other windows and the groups, from the same scene.
  const scene = $derived.by(() => {
    void model.revision;
    const state = model.app?.workspace.getState();
    if (state === undefined || selected === null) {
      return null;
    }
    const node = state.nodes.get(selected.id);
    if (node === undefined) {
      return null;
    }
    const nameOf = (n: { id: string; label: string | null }) => n.label ?? n.id;
    const surfaces = node.surfaceIds.flatMap((id) => {
      const surface = state.surfaces.get(id);
      if (surface === undefined) {
        return [];
      }
      const kind = contentOf(surface.adapterTypeId);
      return [
        {
          id,
          label: surface.label ?? id,
          detail: kind === null ? surface.adapterTypeId : t(`content.${kind}`),
        },
      ];
    });
    const windows = [...state.nodes.values()]
      .filter((n) => n.kind === 'window' && n.status === 'active' && n.id !== node.id)
      .map((n) => ({ value: n.id, label: nameOf(n) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    const groups = [...state.nodes.values()]
      .filter((n) => n.kind === 'group' && n.status === 'active' && n.id !== node.parentId)
      .map((n) => ({ value: n.id, label: nameOf(n) }));
    return { surfaces, windows, groups };
  });

  // What each composition control has chosen, until it acts.
  let moving = $state('');
  let movingTo = $state('');
  let mergeInto = $state('');
  let group = $state('');
  let groupName = $state('');
  const NEW_GROUP = '\u0000new';

  // A different window selected starts the choices afresh.
  $effect(() => {
    void selected?.id;
    moving = '';
    movingTo = '';
    mergeInto = '';
    group = '';
    groupName = '';
  });

  const refusal = $derived(
    model.refusal !== null && model.isInspectorRefusal(model.refusal) ? model.refusal : null,
  );
</script>

<Panel title={t('inspector.title')} titled={false} handle={handleOf`page.inspector`}>
  {#if selected === null}
    <EmptyState icon="info" title={t('inspector.none')} detail={t('inspector.none.detail')} />
  {:else}
    <Stack inset gap="large">
      <Facts ariaLabel={t('inspector.label')} items={facts} />
      {#if refusal !== null}
        <Notice tone="danger" title={model.refusalText(refusal)} handle={handleOf`page.inspector.refusal`} />
      {/if}
      {#if scene !== null}
        <Section
          title={t('inspector.surfaces')}
          detail={t('inspector.surfaces.detail')}
          handle={handleOf`page.inspector.surfaces`}
        >
          <Stack gap="small">
            <List ariaLabel={t('inspector.surfaces')}>
              {#each scene.surfaces as surface (surface.id)}
                <ListItem title={surface.label} detail={surface.detail} icon="document">
                  {#snippet actions()}
                    {#if composing}
                      <IconButton
                        handle={keyed('page.inspector.detach', surface.id)}
                        icon="split-beside"
                        label={scene.surfaces.length < 2
                          ? t('inspector.surface.only')
                          : t('inspector.surface.detach')}
                        size="small"
                        disabled={scene.surfaces.length < 2}
                        onpress={() => {
                          void model.run('reference.surface.detach', { surfaceId: surface.id });
                        }}
                      />
                    {/if}
                  {/snippet}
                </ListItem>
              {/each}
            </List>
            {#if !composing}
              <Text quiet>{t('inspector.composition.off')}</Text>
            {:else}
              {#if scene.surfaces.length < 2}
                <Text quiet>{t('inspector.surface.only')}</Text>
              {/if}
              {#if scene.windows.length > 0}
                {#snippet moveControl()}
                  <Stack gap="small">
                    {#if scene.surfaces.length > 1}
                      <Select
                        handle={handleOf`page.inspector.move.surface`}
                        id="reference-move-surface"
                        options={[
                          { value: '', label: t('inspector.surface.move.surface') },
                          ...scene.surfaces.map((s) => ({ value: s.id, label: s.label })),
                        ]}
                        value={moving}
                        onchange={(value) => {
                          moving = value;
                        }}
                      />
                    {/if}
                    <Select
                      handle={handleOf`page.inspector.move.window`}
                      id="reference-move-window"
                      options={[{ value: '', label: t('inspector.surface.move.choose') }, ...scene.windows]}
                      value={movingTo}
                      onchange={(value) => {
                        movingTo = value;
                      }}
                    />
                  </Stack>
                {/snippet}
                {@const surfaceId = scene.surfaces.length > 1 ? moving : (scene.surfaces[0]?.id ?? '')}
                <Field label={t('inspector.surface.move')} for="reference-move-window" control={moveControl} />
                <Stack direction="row">
                  <Button
                    handle={handleOf`page.inspector.move`}
                    label={t('inspector.surface.move')}
                    icon="tab-move"
                    size="small"
                    disabled={surfaceId === '' || movingTo === ''}
                    onpress={() => {
                      void model.run('reference.surface.move', { surfaceId, windowId: movingTo });
                    }}
                  />
                </Stack>
                {#snippet mergeControl()}
                  <Select
                    handle={handleOf`page.inspector.merge.window`}
                    id="reference-merge-window"
                    options={[{ value: '', label: t('inspector.surface.move.choose') }, ...scene.windows]}
                    value={mergeInto}
                    onchange={(value) => {
                      mergeInto = value;
                    }}
                  />
                {/snippet}
                <Field label={t('inspector.window.merge')} for="reference-merge-window" control={mergeControl} />
                <Stack direction="row">
                  <Button
                    handle={handleOf`page.inspector.merge`}
                    label={t('inspector.window.merge')}
                    size="small"
                    disabled={mergeInto === ''}
                    onpress={() => {
                      void model.run('reference.window.merge', { id: selected.id, targetId: mergeInto });
                    }}
                  />
                </Stack>
              {/if}
              {#snippet groupControl()}
                <Select
                  handle={handleOf`page.inspector.group.target`}
                  id="reference-group"
                  options={[
                    { value: '', label: t('inspector.window.group.choose') },
                    ...scene.groups,
                    { value: NEW_GROUP, label: t('inspector.window.group.new') },
                  ]}
                  value={group}
                  onchange={(value) => {
                    group = value;
                  }}
                />
              {/snippet}
              <Field label={t('inspector.window.group')} for="reference-group" control={groupControl} />
              {#if group === NEW_GROUP}
                {#snippet nameControl()}
                  <Input
                    handle={handleOf`page.inspector.group.name`}
                    id="reference-group-name"
                    value={groupName}
                    oninput={(value) => {
                      groupName = value;
                    }}
                  />
                {/snippet}
                <Field label={t('inspector.window.group.name')} for="reference-group-name" control={nameControl} />
              {/if}
              <Stack direction="row">
                <Button
                  handle={handleOf`page.inspector.group`}
                  label={t('inspector.window.group.move')}
                  size="small"
                  disabled={group === '' || (group === NEW_GROUP && groupName.trim() === '')}
                  onpress={() => {
                    void model.run('reference.window.regroup', {
                      id: selected.id,
                      groupId: group === NEW_GROUP ? null : group,
                      label: groupName,
                    });
                  }}
                />
              </Stack>
            {/if}
          </Stack>
        </Section>
      {/if}
      <Section title={t('inspector.remove')} detail={t('inspector.remove.detail')} handle={handleOf`page.inspector.removal`}>
        <Stack direction="row">
          <Button
            handle={handleOf`page.inspector.remove`}
            label={t('inspector.remove')}
            icon="delete"
            onpress={() => {
              void model.removeWindow(selected.id);
            }}
          />
        </Stack>
      </Section>
    </Stack>
  {/if}
</Panel>
