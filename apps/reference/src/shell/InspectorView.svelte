<script lang="ts">
  // WHAT IS SELECTED: the window's identity and where it is around the camera, in degrees and
  // world units, formatted for the reader's locale (the scene keeps its own numbers); the surfaces
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
    Select,
    Stack,
    Text,
  } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import type { MessageId } from '../messages.js';
  import { contentOf } from '../presets.js';
  import type { AppCommandId } from '../commands.js';
  import type { ShellModel } from './model.svelte.js';
  import WindowActions from './WindowActions.svelte';

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
            term: t('inspector.turned'),
            value: t('inspector.degrees', { value: round(selected.turned, 1) }),
          },
          {
            term: t('inspector.size'),
            value: t('inspector.size.value', {
              width: round(selected.width, 2),
              height: round(selected.height, 2),
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

  // PLACING IT (UX-006, UX-012, UX-014): every drag, resize handle and wheel or pinch has its
  // control here, so neither a pointer's precision nor a device's gestures are needed. A step is
  // coarse enough to see; the exact entries take any value.
  const STEP = Object.freeze({ move: 0.25, depth: 0.25, degrees: 15, size: 0.1 });
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
      ...(selected.rotatable ? [] : [t('inspector.place.fixed.rotate')]),
      ...(selected.resizable ? [] : [t('inspector.place.fixed.resize')]),
    ];
  });
  const canMove = $derived(selected !== null && selected.movable && !selected.locked);
  const canTurn = $derived(selected !== null && selected.rotatable && !selected.locked);
  const canSize = $derived(selected !== null && selected.resizable && !selected.locked);

  type Exact = 'x' | 'y' | 'z' | 'turned' | 'width' | 'height';
  const EXACT: readonly Exact[] = ['x', 'y', 'z', 'turned', 'width', 'height'];
  /** What is typed in each exact entry, until it is applied; none shows the value now. */
  let drafts = $state<Partial<Record<Exact, string>>>({});
  $effect(() => {
    void selected?.id;
    drafts = {};
  });
  const current = (field: Exact): number => {
    if (selected === null) {
      return 0;
    }
    switch (field) {
      case 'x':
        return selected.position[0];
      case 'y':
        return selected.position[1];
      case 'z':
        return selected.position[2];
      case 'turned':
        return selected.turned;
      case 'width':
        return selected.width;
      case 'height':
        return selected.height;
    }
  };
  const shown = (field: Exact) => drafts[field] ?? String(round(current(field), 3));
  const typed = (field: Exact): number | undefined => {
    const draft = drafts[field];
    return draft === undefined ? undefined : draft.trim() === '' ? Number.NaN : Number(draft);
  };
  /** The commands an exact entry's refusal belongs to, by the field it names. */
  const EXACT_COMMANDS: Readonly<Record<Exact, AppCommandId>> = {
    x: 'reference.window.place',
    y: 'reference.window.place',
    z: 'reference.window.place',
    turned: 'reference.window.face',
    width: 'reference.window.size',
    height: 'reference.window.size',
  };
  const REFUSED_FIELD: Readonly<Record<string, Exact>> = { degrees: 'turned' };
  const messageOf = (field: Exact): string | undefined =>
    refusal !== null &&
    refusal.command === EXACT_COMMANDS[field] &&
    (REFUSED_FIELD[refusal.field] ?? refusal.field) === field
      ? refusal.message
      : undefined;

  /**
   * A refusal of an exact entry is said by its field, as an alert under the entry it names; it is
   * not said again over the inspector.
   */
  const exactRefused = $derived(EXACT.some((field) => messageOf(field) !== undefined));

  /** Places the window as the exact entries say: each changed entry, one change apiece. */
  async function applyExact(id: string): Promise<void> {
    const [x, y, z] = [typed('x'), typed('y'), typed('z')];
    if (x !== undefined || y !== undefined || z !== undefined) {
      // A place on the ground is given whole: the entry not changed keeps its value.
      const ground = x !== undefined || z !== undefined;
      const done = await model.run('reference.window.place', {
        id,
        ...(ground ? { x: x ?? current('x'), z: z ?? current('z') } : {}),
        ...(y === undefined ? {} : { y }),
      });
      if (!done) {
        return;
      }
    }
    const turned = typed('turned');
    if (turned !== undefined && !(await model.run('reference.window.face', { id, degrees: turned }))) {
      return;
    }
    const [width, height] = [typed('width'), typed('height')];
    if (
      (width !== undefined || height !== undefined) &&
      !(await model.run('reference.window.size', {
        id,
        width: width ?? current('width'),
        height: height ?? current('height'),
      }))
    ) {
      return;
    }
    drafts = {};
  }
</script>

{#snippet step(handle: string, label: string, enabled: boolean, command: () => void)}
  <Button handle={keyed('page.inspector.step', handle)} {label} size="small" disabled={!enabled} onpress={command} />
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
      {#if refusal !== null && !exactRefused}
        <Notice tone="danger" title={model.refusalText(refusal)} handle={handleOf`page.inspector.refusal`} />
      {/if}
      <Section title={t('inspector.place')} detail={t('inspector.place.detail')} handle={handleOf`page.inspector.place`}>
        <Stack gap="small">
          {#each fixed as reason (reason)}
            <Text quiet>{reason}</Text>
          {/each}
          <ButtonGroup ariaLabel={t('inspector.place.steps')}>
            {@render step('left', t('inspector.place.left'), canMove, () => {
              void model.run('reference.window.nudge', { id: selected.id, right: -STEP.move });
            })}
            {@render step('right', t('inspector.place.right'), canMove, () => {
              void model.run('reference.window.nudge', { id: selected.id, right: STEP.move });
            })}
            {@render step('up', t('inspector.place.up'), canMove, () => {
              void model.run('reference.window.nudge', { id: selected.id, up: STEP.move });
            })}
            {@render step('down', t('inspector.place.down'), canMove, () => {
              void model.run('reference.window.nudge', { id: selected.id, up: -STEP.move });
            })}
            {@render step('nearer', t('inspector.place.nearer'), canMove, () => {
              void model.run('reference.window.nudge', { id: selected.id, depth: -STEP.depth });
            })}
            {@render step('farther', t('inspector.place.farther'), canMove, () => {
              void model.run('reference.window.nudge', { id: selected.id, depth: STEP.depth });
            })}
            {@render step('turn-left', t('inspector.place.turnLeft'), canTurn, () => {
              void model.run('reference.window.turn', { id: selected.id, degrees: -STEP.degrees });
            })}
            {@render step('turn-right', t('inspector.place.turnRight'), canTurn, () => {
              void model.run('reference.window.turn', { id: selected.id, degrees: STEP.degrees });
            })}
            {@render step('narrower', t('inspector.place.narrower'), canSize, () => {
              void model.run('reference.window.resize', { id: selected.id, width: -STEP.size });
            })}
            {@render step('wider', t('inspector.place.wider'), canSize, () => {
              void model.run('reference.window.resize', { id: selected.id, width: STEP.size });
            })}
            {@render step('shorter', t('inspector.place.shorter'), canSize, () => {
              void model.run('reference.window.resize', { id: selected.id, height: -STEP.size });
            })}
            {@render step('taller', t('inspector.place.taller'), canSize, () => {
              void model.run('reference.window.resize', { id: selected.id, height: STEP.size });
            })}
          </ButtonGroup>
          <Stack direction="row" gap="small" wrap>
            {#if held}
              <Button
                handle={handleOf`page.inspector.drop`}
                label={t('command.gesture.drop')}
                size="small"
                variant="primary"
                onpress={() => {
                  void model.run('reference.gesture.drop', {});
                }}
              />
              <Button
                handle={handleOf`page.inspector.cancel`}
                label={t('gesture.cancel')}
                size="small"
                onpress={() => {
                  void model.run('reference.gesture.cancel', {});
                }}
              />
            {:else}
              <Button
                handle={handleOf`page.inspector.grab`}
                label={t('command.gesture.grab.named', { label: selected.label ?? selected.id })}
                size="small"
                disabled={!(canMove || canTurn || canSize)}
                onpress={() => {
                  void model.run('reference.gesture.grab', { id: selected.id });
                }}
              />
            {/if}
          </Stack>
          {#each EXACT as field (field)}
            {#snippet exactControl()}
              <Input
                handle={keyed('page.inspector.exact', field)}
                id={`reference-exact-${field}`}
                type="text"
                value={shown(field)}
                disabled={field === 'turned' ? !canTurn : field === 'width' || field === 'height' ? !canSize : !canMove}
                oninput={(value) => {
                  drafts = { ...drafts, [field]: value };
                }}
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    void applyExact(selected.id);
                  }
                }}
              />
            {/snippet}
            <Field
              label={t(`inspector.place.${field === 'turned' ? 'turned' : field}`)}
              for={`reference-exact-${field}`}
              control={exactControl}
              hint={field === 'y' ? t('inspector.place.position.hint') : field === 'turned' ? t('inspector.place.turned.hint') : field === 'height' ? t('inspector.place.size.hint') : undefined}
              message={messageOf(field)}
              messageTone="danger"
            />
          {/each}
          <Stack direction="row">
            <Button
              handle={handleOf`page.inspector.exact.apply`}
              label={t('inspector.place.apply')}
              size="small"
              disabled={Object.keys(drafts).length === 0}
              onpress={() => {
                void applyExact(selected.id);
              }}
            />
          </Stack>
          <Checkbox
            handle={handleOf`page.inspector.lock`}
            id="reference-lock"
            label={t('inspector.lock')}
            detail={t('inspector.lock.detail')}
            checked={selected.locked}
            onchange={(locked) => {
              void model.run('reference.window.lock', { id: selected.id, locked });
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
