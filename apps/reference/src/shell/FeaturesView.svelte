<script lang="ts">
  // THE EIGHT BEHAVIOUR MODULES, each on or off on its own, with what it does said beside it and
  // its settings under it: focus and context, workspace orbit (what background drags turn, which
  // group, turns by step, the camera's heading and the workspace's turn side by side to compare),
  // the spatial map, semantic depth (its bands), magnetic positioning (its thresholds and gap), the
  // wrapped cursor (what it cannot do), composition, and saving and opening workspaces. A control
  // that cannot act says why. Turning every feature on is the combined preset; reset also puts
  // every setting back to its default.
  import {
    Button,
    Checkbox,
    Facts,
    Field,
    Input,
    Notice,
    Panel,
    Section,
    Segmented,
    Select,
    Stack,
    Text,
  } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { VIEWPORT_ID } from '../app.js';
  import type { AppCommandId } from '../commands.js';
  import type { FeatureId } from '../features.js';
  import type { MessageId } from '../messages.js';
  import { cameraHeading, orbitHeading } from '../orbit.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);
  const DEGREES = 180 / Math.PI;
  /** Settings said under their own fields when refused. */
  const NUMBER_FIELDS = ['depth.full', 'depth.compact', 'snap.linear', 'snap.angular', 'snap.padding'];
  const round = (value: number, digits: number) => Number(value.toFixed(digits));

  const status = $derived(model.policies);
  const enabled = $derived(status?.features.enabled ?? null);

  function toggle(feature: FeatureId, on: boolean): void {
    void model.run('reference.feature.set', { feature, enabled: on });
  }

  // The groups a workspace orbit can turn, and the readings that compare camera and workspace.
  const scene = $derived.by(() => {
    void model.revision;
    const app = model.app;
    if (app === null) {
      return null;
    }
    const state = app.workspace.getState();
    const groups = [...state.nodes.values()]
      .filter((node) => node.kind === 'group' && node.status === 'active')
      .map((node) => ({ value: node.id, label: node.label ?? node.id }));
    const turned = orbitHeading(state);
    return {
      groups,
      // Read with the groups, from the same scene, so the chosen one is always among them.
      rootId: state.orbitRootId,
      camera: cameraHeading(state, VIEWPORT_ID) * DEGREES,
      turned: turned === null ? null : turned * DEGREES,
    };
  });

  const navigationNote = $derived.by(() => {
    if (status === null || enabled === null) {
      return null;
    }
    if (!enabled.orbit) {
      return t('orbit.navigation.off');
    }
    return status.orbit.rootId === null ? t('orbit.navigation.noroot') : null;
  });

  /** The refusal of a setting, said under its field. */
  function problem(command: AppCommandId, field: string): string | undefined {
    const refusal = model.refusal;
    return refusal?.command === command && refusal.field === field
      ? t('setting.invalid', { reason: refusal.message })
      : undefined;
  }

  // What each number field shows: the setting, until the reader types.
  let typed = $state<Record<string, string>>({});
  const shown = (key: string, value: number) => typed[key] ?? String(value);
  function settle(key: string, text: string, apply: (value: number) => Promise<boolean>): void {
    const value = text.trim() === '' ? Number.NaN : Number(text);
    void apply(value).then((done) => {
      if (done) {
        const { [key]: _, ...rest } = typed;
        typed = rest;
      }
    });
  }
</script>

{#snippet numberField(
  key: string,
  label: string,
  hint: string,
  value: number,
  command: AppCommandId,
  field: string,
  disabled: boolean,
  apply: (value: number) => Promise<boolean>,
)}
  {@const message = problem(command, field)}
  {#snippet control()}
    <Input
      handle={handleOf`page.features.${key}`}
      id={`reference-${key}`}
      type="number"
      min={0}
      step={0.01}
      value={shown(key, value)}
      invalid={message !== undefined}
      {disabled}
      oninput={(text) => {
        typed = { ...typed, [key]: text };
      }}
      onchange={(text) => {
        settle(key, text, apply);
      }}
    />
  {/snippet}
  <Field
    {label}
    for={`reference-${key}`}
    {control}
    {hint}
    {...message === undefined ? {} : { message, messageTone: 'danger' as const }}
  />
{/snippet}

<Panel title={t('features.title')} titled={false} handle={handleOf`page.features`}>
  {#if status !== null && enabled !== null}
    <Stack inset gap="large">
      {#if model.refusal !== null && model.isFeatureRefusal(model.refusal) && !NUMBER_FIELDS.includes(model.refusal.field)}
        <Notice
          tone="danger"
          title={model.refusalText(model.refusal)}
          handle={handleOf`page.features.refusal`}
        />
      {/if}
      <Section title={t('focus.feature.title')} detail={t('focus.feature.detail')} handle={handleOf`page.features.focus`}>
        <Stack gap="small">
          <Checkbox
            handle={handleOf`page.features.focus.enabled`}
            id="reference-focus-enabled"
            label={t('focus.feature.enabled')}
            checked={enabled.focus}
            onchange={(on) => {
              toggle('focus', on);
            }}
          />
        </Stack>
      </Section>

      <Section title={t('orbit.title')} detail={t('orbit.detail')} handle={handleOf`page.features.orbit`}>
        <Stack gap="small">
          <Checkbox
            handle={handleOf`page.features.orbit.enabled`}
            id="reference-orbit-enabled"
            label={t('orbit.enabled')}
            checked={enabled.orbit}
            onchange={(on) => {
              toggle('orbit', on);
            }}
          />
          {#if enabled.orbit}
            {#snippet navigationControl()}
              <Segmented
                handle={handleOf`page.features.orbit.navigation`}
                ariaLabel={t('orbit.navigation')}
                items={[
                  { value: 'camera', label: t('orbit.navigation.camera') },
                  {
                    value: 'orbit',
                    label: t('orbit.navigation.orbit'),
                    disabled: status.orbit.rootId === null,
                    ...(status.orbit.rootId === null ? { title: t('orbit.navigation.noroot') } : {}),
                  },
                ]}
                selected={status.orbit.navigation}
                onselect={(target) => {
                  void model.run('reference.navigation.set', {
                    target: target as 'camera' | 'orbit',
                  });
                }}
              />
            {/snippet}
            <Field label={t('orbit.navigation')} group control={navigationControl} />
            {#snippet groupControl()}
              <Select
                handle={handleOf`page.features.orbit.group`}
                id="reference-orbit-group"
                options={[{ value: '', label: t('orbit.group.none') }, ...(scene?.groups ?? [])]}
                value={scene?.rootId ?? ''}
                onchange={(value) => {
                  void model.run('reference.orbit.designate', { id: value === '' ? null : value });
                }}
              />
            {/snippet}
            <Field label={t('orbit.group')} for="reference-orbit-group" control={groupControl} />
            <Stack direction="row" gap="small" wrap>
              <Button
                handle={handleOf`page.features.orbit.left`}
                label={t('orbit.turn.left')}
                disabled={status.orbit.rootId === null}
                onpress={() => {
                  void model.run('reference.orbit.turn', { degrees: -15 });
                }}
              />
              <Button
                handle={handleOf`page.features.orbit.right`}
                label={t('orbit.turn.right')}
                disabled={status.orbit.rootId === null}
                onpress={() => {
                  void model.run('reference.orbit.turn', { degrees: 15 });
                }}
              />
            </Stack>
          {/if}
          {#if navigationNote !== null}
            <Text quiet>{navigationNote}</Text>
          {/if}
          {#if scene !== null}
            <Facts
              ariaLabel={t('orbit.readings')}
              items={[
                {
                  term: t('orbit.camera'),
                  value: t('inspector.degrees', { value: round(scene.camera, 1) }),
                },
                {
                  term: t('orbit.turned'),
                  value:
                    scene.turned === null
                      ? t('orbit.group.none')
                      : t('inspector.degrees', { value: round(scene.turned, 1) }),
                },
              ]}
            />
          {/if}
        </Stack>
      </Section>

      <Section title={t('map.feature.title')} detail={t('map.feature.detail')} handle={handleOf`page.features.map`}>
        <Stack gap="small">
          <Checkbox
            handle={handleOf`page.features.map.enabled`}
            id="reference-map-enabled"
            label={t('map.feature.enabled')}
            checked={enabled.map}
            onchange={(on) => {
              toggle('map', on);
            }}
          />
        </Stack>
      </Section>

      <Section title={t('depth.title')} detail={t('depth.detail')} handle={handleOf`page.features.depth`}>
        <Stack gap="small">
          <Checkbox
            handle={handleOf`page.features.depth.enabled`}
            id="reference-depth-enabled"
            label={t('depth.enabled')}
            checked={enabled.depth}
            onchange={(on) => {
              toggle('depth', on);
            }}
          />
          {#if enabled.depth}
            {@render numberField('depth-full', t('depth.full'), t('depth.full.hint'), status.features.depth.full, 'reference.depth.configure', 'depth.full', false, (full) =>
              model.run('reference.depth.configure', { full }),
            )}
            {@render numberField('depth-compact', t('depth.compact'), t('depth.compact.hint'), status.features.depth.compact, 'reference.depth.configure', 'depth.compact', false, (compact) =>
              model.run('reference.depth.configure', { compact }),
            )}
          {/if}
        </Stack>
      </Section>

      <Section title={t('snap.title')} detail={t('snap.detail')} handle={handleOf`page.features.snap`}>
        <Stack gap="small">
          <Checkbox
            handle={handleOf`page.features.snap.enabled`}
            id="reference-snap-enabled"
            label={t('snap.enabled')}
            checked={enabled.snap}
            onchange={(on) => {
              toggle('snap', on);
            }}
          />
          {#if enabled.snap}
            {@render numberField('snap-linear', t('snap.linear'), t('snap.linear.hint'), status.features.snap.linear, 'reference.snap.configure', 'snap.linear', false, (linear) =>
              model.run('reference.snap.configure', { linear }),
            )}
            {@render numberField('snap-angular', t('snap.angular'), t('snap.angular.hint'), status.features.snap.angular, 'reference.snap.configure', 'snap.angular', false, (angular) =>
              model.run('reference.snap.configure', { angular }),
            )}
            {@render numberField('snap-padding', t('snap.padding'), t('snap.padding.hint'), status.features.snap.padding, 'reference.snap.configure', 'snap.padding', false, (padding) =>
              model.run('reference.snap.configure', { padding }),
            )}
          {/if}
        </Stack>
      </Section>

      <Section title={t('cursor.title')} detail={t('cursor.detail')} handle={handleOf`page.features.cursor`}>
        <Stack gap="small">
          <Checkbox
            handle={handleOf`page.features.cursor.enabled`}
            id="reference-cursor-enabled"
            label={t('cursor.enabled')}
            checked={enabled.cursor}
            onchange={(on) => {
              toggle('cursor', on);
            }}
          />
          {#if enabled.cursor}
            <Notice tone="info" title={t('cursor.limits')} handle={handleOf`page.features.cursor.limits`} />
            {#if !status.wraps}
              <Text quiet>{t('cursor.unavailable')}</Text>
            {/if}
          {/if}
        </Stack>
      </Section>

      <Section title={t('composition.title')} detail={t('composition.detail')} handle={handleOf`page.features.composition`}>
        <Stack gap="small">
          <Checkbox
            handle={handleOf`page.features.composition.enabled`}
            id="reference-composition-enabled"
            label={t('composition.enabled')}
            checked={enabled.composition}
            onchange={(on) => {
              toggle('composition', on);
            }}
          />
        </Stack>
      </Section>

      <Section title={t('persistence.title')} detail={t('persistence.detail')} handle={handleOf`page.features.persistence`}>
        <Stack gap="small">
          <Checkbox
            handle={handleOf`page.features.persistence.enabled`}
            id="reference-persistence-enabled"
            label={t('persistence.enabled')}
            checked={enabled.persistence}
            onchange={(on) => {
              toggle('persistence', on);
            }}
          />
          {#if !enabled.persistence}
            <Text quiet>{t('persistence.off')}</Text>
          {/if}
        </Stack>
      </Section>

      <Stack gap="small">
        <Stack direction="row" gap="small" wrap>
          <Button
            handle={handleOf`page.features.combine`}
            label={t('features.combine')}
            icon="check"
            onpress={() => {
              void model.run('reference.feature.combine', {});
            }}
          />
          <Button
            handle={handleOf`page.features.reset`}
            label={t('features.reset')}
            icon="undo"
            onpress={() => {
              typed = {};
              void model.run('reference.feature.reset', {});
            }}
          />
        </Stack>
        <Text quiet>{t('features.combine.detail')}</Text>
      </Stack>
    </Stack>
  {/if}
</Panel>
