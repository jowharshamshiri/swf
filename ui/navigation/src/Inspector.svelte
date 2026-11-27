<script lang="ts">
  // WHAT IS SELECTED: the window's identity, whether it is in front of the camera or behind it,
  // and where it stands, formatted for the reader's locale (the scene keeps its own numbers); the
  // kit's sliders that move it round the camera, out and up, and size it, each previewing
  // as it is dragged and one undoable change when let go; the surfaces
  // the host supplied for it, each detached into a window of its own or moved into another window
  // whole, never split (FR-126, AC-016); merging it into another window and moving it into a group;
  // and removing it from the workspace, which says it does not delete or stop its content (UX-011).
  import {
    Button,
    ButtonGroup,
    Checkbox,
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
    SectionLabel,
    Select,
    Slider,
    Stack,
    Text,
  } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import { ROOM_LIMITS } from '@swf/interaction';
  import type { NavigationMessageId } from './messages.js';
  import type { NavigationModel } from './model.svelte.js';
  import WindowActions from './WindowActions.svelte';

  interface Props {
    model: NavigationModel;
  }

  let { model }: Props = $props();
  const t = (id: NavigationMessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);
  const round = (value: number, digits: number) => Number(value.toFixed(digits));

  const selected = $derived(model.selected);
  const composing = $derived(model.policies?.features.enabled.composition ?? false);

  // The selected window's surfaces, the other windows and the groups, from the same scene.
  const scene = $derived.by(() => {
    void model.revision;
    const app = model.navigation;
    if (app === null || selected === null) {
      return null;
    }
    const state = app.workspace.getState();
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
      const shows = model.content.describe(surface);
      return [
        {
          id,
          label: surface.label ?? id,
          detail: shows ?? surface.adapterTypeId,
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
    // The window it is a part of, and how many parts that one (or this one) has.
    const originId = app.partOf(node);
    const origin = originId === null ? undefined : state.nodes.get(originId);
    const parts = [...state.nodes.values()].filter(
      (n) => n.kind === 'window' && n.status === 'active' && app.partOf(n) === (originId ?? node.id),
    ).length;
    return {
      surfaces,
      windows,
      groups,
      origin: origin === undefined ? null : nameOf(origin),
      parts,
    };
  });

  const facts = $derived(
    selected === null
      ? []
      : [
          { term: t('inspector.id'), value: selected.id, literal: true },
          { term: t('inspector.name'), value: selected.label ?? selected.id },
          ...(selected.content === null
            ? []
            : [{ term: t('inspector.content'), value: selected.content }]),
          ...(scene === null || scene.origin === null
            ? scene !== null && scene.parts > 0
              ? [{ term: t('inspector.parts'), value: t('inspector.parts.value', { count: scene.parts }) }]
              : []
            : [{ term: t('inspector.partOf'), value: t('inspector.partOf.value', { label: scene.origin }) }]),
          {
            term: t('inspector.side'),
            value: t(selected.side === 'front' ? 'inspector.side.front' : 'inspector.side.behind'),
          },
          {
            term: t('inspector.position'),
            value: t('inspector.position.value', {
              x: round(selected.position[0], 2),
              y: round(selected.position[1], 2),
              z: round(selected.position[2], 2),
            }),
          },
          {
            term: t('inspector.locked'),
            value: t(selected.locked ? 'inspector.locked.yes' : 'inspector.locked.no'),
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


  // The windows selected together, the inspected one first, and the name a group of them is given.
  const together = $derived.by(() => {
    void model.revision;
    const state = model.navigation?.workspace.getState();
    return model.selection.flatMap((id) => {
      const node = state?.nodes.get(id);
      return node === undefined ? [] : [{ id, label: node.label ?? id }];
    });
  });
  let togetherLabel = $state('');

  // What each composition control has chosen, until it acts.
  let moving = $state('');
  let movingTo = $state('');
  let mergeInto = $state('');
  let group = $state('');
  let groupName = $state('');
  const NEW_GROUP = '\u0000new';

  /**
   * A choice the scene no longer offers (its surface moved away, its window merged, its group now
   * the window's own parent, or the scene put back by undo) is no choice: each control shows, and
   * acts on, only what is still offered.
   */
  const offered = (value: string, values: readonly string[]) => (values.includes(value) ? value : '');
  const chosen = $derived({
    moving: offered(moving, scene?.surfaces.map((surface) => surface.id) ?? []),
    movingTo: offered(movingTo, scene?.windows.map((window) => window.value) ?? []),
    mergeInto: offered(mergeInto, scene?.windows.map((window) => window.value) ?? []),
    group: group === NEW_GROUP ? NEW_GROUP : offered(group, scene?.groups.map((g) => g.value) ?? []),
  });

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
    model.refusal !== null && model.placeOf(model.refusal) === 'inspector' ? model.refusal : null,
  );

  // PLACING IT (UX-006, UX-012, UX-014): every drag, resize handle and wheel or pinch has
  // its control here, so neither a pointer's precision nor a device's gestures are needed. Each is
  // the kit's slider: dragged, the window moves as it goes (a preview) and letting go commits it
  // once; a key moves it a step and a typed number puts it exactly there, each one change.
  const held = $derived(
    model.policies?.gesture?.operation === 'gesture.grab' &&
      model.policies.gesture.nodeId === selected?.id,
  );
  // What stops it being placed, said under the controls it disables.
  const fixed = $derived.by(() => {
    if (selected === null) {
      return [];
    }
    if (selected.locked) {
      return [t('inspector.place.locked')];
    }
    return [
      ...(selected.movable ? [] : [t('inspector.place.fixed.move')]),
      ...(selected.resizable ? [] : [t('inspector.place.fixed.resize')]),
    ];
  });
  const canMove = $derived(selected !== null && selected.movable && !selected.locked);
  const canSize = $derived(selected !== null && selected.resizable && !selected.locked);

  type PoseField = 'heading' | 'reach' | 'y' | 'width' | 'height';
  /**
   * Each slider's range and step. Distances, heights and sizes reach past their usual range when
   * the window already stands beyond it, to the step past where it is, so it can always be shown.
   */
  const SCALE: Readonly<Record<PoseField, { min: number; max: number; step: number; degrees: boolean }>> = {
    heading: { min: -180, max: 180, step: 1, degrees: true },
    reach: { min: ROOM_LIMITS.nearest, max: ROOM_LIMITS.farthest, step: 0.1, degrees: false },
    y: { min: ROOM_LIMITS.lowest, max: ROOM_LIMITS.highest, step: 0.1, degrees: false },
    width: { min: 0.1, max: 8, step: 0.05, degrees: false },
    height: { min: 0.1, max: 8, step: 0.05, degrees: false },
  };
  const valueOf = (field: PoseField): number => {
    if (selected === null) {
      return 0;
    }
    switch (field) {
      case 'heading':
        return selected.heading;
      case 'reach':
        return selected.reach;
      case 'y':
        return selected.position[1];
      case 'width':
        return selected.width;
      case 'height':
        return selected.height;
    }
  };
  /** A slider's range, held on its step's grid, reaching the value wherever it is. */
  const rangeOf = (field: PoseField): { min: number; max: number } => {
    const { min, max, step } = SCALE[field];
    const value = valueOf(field);
    const decimals = String(step).split('.')[1]?.length ?? 0;
    const grid = (n: number) => Number((n * step).toFixed(decimals));
    return {
      min: Math.min(min, grid(Math.floor(value / step))),
      max: Math.max(max, grid(Math.ceil(value / step))),
    };
  };
  const enabledFor = (field: PoseField): boolean =>
    field === 'width' || field === 'height' ? canSize : canMove;

  /** Poses the selected window by one slider: shown while it moves, committed once when let go. */
  function pose(id: string, field: PoseField, value: number, preview: boolean): void {
    void model.run('swf.window.pose', { id, [field]: value, preview });
  }
  const PLACE_FIELDS: readonly PoseField[] = ['heading', 'reach', 'y'];
  const STAND_FIELDS: readonly PoseField[] = ['width', 'height'];
</script>

{#snippet poseSlider(id: string, field: PoseField)}
  {@const range = rangeOf(field)}
  <Slider
    handle={keyed('page.inspector.pose', field)}
    label={t(`inspector.place.${field}`)}
    value={valueOf(field)}
    min={range.min}
    max={range.max}
    step={SCALE[field].step}
    unit={SCALE[field].degrees ? '°' : t('inspector.place.units')}
    field
    disabled={!enabledFor(field)}
    oninput={(value) => {
      pose(id, field, value, true);
    }}
    onchange={(value) => {
      pose(id, field, value, false);
    }}
  />
{/snippet}

<Panel title={t('inspector.title')} titled={false} handle={handleOf`page.inspector`}>
  {#if selected === null}
    <EmptyState icon="info" title={t('inspector.none')} detail={t('inspector.none.detail')} />
  {:else}
    <Stack inset gap="large">
      <Facts ariaLabel={t('inspector.label')} items={facts} />
      <ButtonGroup ariaLabel={t('inspector.actions')}>
        <WindowActions {model} id={selected.id} handle="page.inspector.window" inspect={false} />
      </ButtonGroup>
      {#if refusal !== null}
        <Notice tone="danger" title={model.refusalText(refusal)} handle={handleOf`page.inspector.refusal`} />
      {/if}
      <Section title={t('inspector.place')} detail={t('inspector.place.detail')} handle={handleOf`page.inspector.place`}>
        <Stack gap="small">
          {#each fixed as reason (reason)}
            <Text quiet>{reason}</Text>
          {/each}
          <SectionLabel text={t('inspector.place.where')} />
          {#each PLACE_FIELDS as field (field)}
            {@render poseSlider(selected.id, field)}
          {/each}
          <Text quiet>{t('inspector.place.where.hint')}</Text>
          <SectionLabel text={t('inspector.place.how')} />
          {#each STAND_FIELDS as field (field)}
            {@render poseSlider(selected.id, field)}
          {/each}
          <Text quiet>{t('inspector.place.how.hint')}</Text>
          <Stack direction="row" gap="small" wrap>
            {#if held}
              <Button
                handle={handleOf`page.inspector.drop`}
                label={t('command.gesture.drop')}
                size="small"
                variant="primary"
                onpress={() => {
                  void model.run('swf.gesture.drop', {});
                }}
              />
              <Button
                handle={handleOf`page.inspector.cancel`}
                label={t('gesture.cancel')}
                size="small"
                onpress={() => {
                  void model.run('swf.gesture.cancel', {});
                }}
              />
            {:else}
              <Button
                handle={handleOf`page.inspector.grab`}
                label={t('command.gesture.grab.named', { label: selected.label ?? selected.id })}
                size="small"
                disabled={!(canMove || canSize)}
                onpress={() => {
                  void model.run('swf.gesture.grab', { id: selected.id });
                }}
              />
            {/if}
          </Stack>
          <Checkbox
            handle={handleOf`page.inspector.lock`}
            id="swf-lock"
            label={t('inspector.lock')}
            detail={t('inspector.lock.detail')}
            checked={selected.locked}
            onchange={(locked) => {
              void model.run('swf.window.lock', { id: selected.id, locked });
            }}
          />
        </Stack>
      </Section>
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
                          void model.run('swf.surface.detach', { surfaceId: surface.id });
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
              <Stack direction="row" gap="small" wrap>
                <Button
                  handle={handleOf`page.inspector.split`}
                  label={t('inspector.split')}
                  icon="split-beside"
                  size="small"
                  disabled={scene.surfaces.length < 2}
                  onpress={() => {
                    void model.run('swf.window.split', { id: selected.id });
                  }}
                />
                <Button
                  handle={handleOf`page.inspector.recombine`}
                  label={t('inspector.recombine')}
                  icon="tab-move"
                  size="small"
                  disabled={scene.parts === 0}
                  onpress={() => {
                    void model.run('swf.window.recombine', { id: selected.id });
                  }}
                />
              </Stack>
              {#if scene.windows.length > 0}
                {#snippet moveControl()}
                  <Stack gap="small">
                    {#if scene.surfaces.length > 1}
                      <Select
                        handle={handleOf`page.inspector.move.surface`}
                        id="swf-move-surface"
                        options={[
                          { value: '', label: t('inspector.surface.move.surface') },
                          ...scene.surfaces.map((s) => ({ value: s.id, label: s.label })),
                        ]}
                        value={chosen.moving}
                        onchange={(value) => {
                          moving = value;
                        }}
                      />
                    {/if}
                    <Select
                      handle={handleOf`page.inspector.move.window`}
                      id="swf-move-window"
                      options={[{ value: '', label: t('inspector.surface.move.choose') }, ...scene.windows]}
                      value={chosen.movingTo}
                      onchange={(value) => {
                        movingTo = value;
                      }}
                    />
                  </Stack>
                {/snippet}
                {@const surfaceId = scene.surfaces.length > 1 ? chosen.moving : (scene.surfaces[0]?.id ?? '')}
                <Field label={t('inspector.surface.move')} for="swf-move-window" control={moveControl} />
                <Stack direction="row">
                  <Button
                    handle={handleOf`page.inspector.move`}
                    label={t('inspector.surface.move')}
                    icon="tab-move"
                    size="small"
                    disabled={surfaceId === '' || chosen.movingTo === ''}
                    onpress={() => {
                      void model.run('swf.surface.move', { surfaceId, windowId: chosen.movingTo });
                    }}
                  />
                </Stack>
                {#snippet mergeControl()}
                  <Select
                    handle={handleOf`page.inspector.merge.window`}
                    id="swf-merge-window"
                    options={[{ value: '', label: t('inspector.surface.move.choose') }, ...scene.windows]}
                    value={chosen.mergeInto}
                    onchange={(value) => {
                      mergeInto = value;
                    }}
                  />
                {/snippet}
                <Field label={t('inspector.window.merge')} for="swf-merge-window" control={mergeControl} />
                <Stack direction="row">
                  <Button
                    handle={handleOf`page.inspector.merge`}
                    label={t('inspector.window.merge')}
                    size="small"
                    disabled={chosen.mergeInto === ''}
                    onpress={() => {
                      void model.run('swf.window.merge', { id: selected.id, targetId: chosen.mergeInto });
                    }}
                  />
                </Stack>
              {/if}
              {#snippet groupControl()}
                <Select
                  handle={handleOf`page.inspector.group.target`}
                  id="swf-group"
                  options={[
                    { value: '', label: t('inspector.window.group.choose') },
                    ...scene.groups,
                    { value: NEW_GROUP, label: t('inspector.window.group.new') },
                  ]}
                  value={chosen.group}
                  onchange={(value) => {
                    group = value;
                  }}
                />
              {/snippet}
              <Field label={t('inspector.window.group')} for="swf-group" control={groupControl} />
              {#if chosen.group === NEW_GROUP}
                {#snippet nameControl()}
                  <Input
                    handle={handleOf`page.inspector.group.name`}
                    id="swf-group-name"
                    value={groupName}
                    oninput={(value) => {
                      groupName = value;
                    }}
                  />
                {/snippet}
                <Field label={t('inspector.window.group.name')} for="swf-group-name" control={nameControl} />
              {/if}
              <Stack direction="row">
                <Button
                  handle={handleOf`page.inspector.group`}
                  label={t('inspector.window.group.move')}
                  size="small"
                  disabled={chosen.group === '' || (chosen.group === NEW_GROUP && groupName.trim() === '')}
                  onpress={() => {
                    void model.run('swf.window.regroup', {
                      id: selected.id,
                      groupId: chosen.group === NEW_GROUP ? null : chosen.group,
                      label: groupName,
                    });
                  }}
                />
              </Stack>
            {/if}
          </Stack>
        </Section>
      {/if}
      {#if together.length > 1}
        {#snippet togetherName()}
          <Input
            handle={handleOf`page.inspector.together.name`}
            id="swf-together-name"
            value={togetherLabel}
            oninput={(value) => {
              togetherLabel = value;
            }}
          />
        {/snippet}
        <Section
          title={t('inspector.together')}
          detail={t('inspector.together.detail', { count: together.length, names: together.map((w) => w.label).join(', ') })}
          handle={handleOf`page.inspector.together`}
        >
          <Stack gap="small">
            <Field label={t('inspector.together.name')} for="swf-together-name" control={togetherName} />
            <Stack direction="row">
              <Button
                handle={handleOf`page.inspector.together.group`}
                label={t('inspector.together.group')}
                size="small"
                disabled={togetherLabel.trim() === ''}
                onpress={() => {
                  void model
                    .run('swf.window.group', {
                      windowIds: together.map((w) => w.id),
                      label: togetherLabel,
                    })
                    .then((done) => {
                      if (done) {
                        togetherLabel = '';
                      }
                    });
                }}
              />
            </Stack>
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
              void model.removeWindows([selected.id]);
            }}
          />
        </Stack>
      </Section>
    </Stack>
  {/if}
</Panel>
