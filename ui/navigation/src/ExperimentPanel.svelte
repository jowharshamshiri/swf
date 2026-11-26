<script lang="ts">
  // THE EXPERIMENT PANEL, optional (a build can leave it out, keeping every capability on): the
  // eight capabilities tried one at a time or together. At its head, what the current combination
  // is and how to try it; then the numbered experiments, each turning its capability on and the
  // rest off and setting the view up to show it (Everything combined turns all eight on); then each
  // capability's switch, in the experiments' order, with its settings under it: workspace rotation
  // (what background drags turn, which group, turns by step, the camera's heading and the
  // workspace's turn side by side to compare), semantic depth (its bands), seamless 360° (what it
  // cannot do), magnetic placement (its thresholds and gap). Switching any capability by hand makes
  // a custom combination. Every control here only configures: it runs the application's commands,
  // which turn the feature modules on and off and set the view through the modules' own
  // contracts; none of a capability's behaviour is here. A control that cannot act says why. Reset
  // turns every capability on and puts every setting back to its default.
  import {
    Button,
    Checkbox,
    Facts,
    Field,
    Input,
    List,
    ListItem,
    Notice,
    Panel,
    Section,
    Segmented,
    Select,
    Stack,
    Text,
  } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import type { ExperimentId, FeatureId, NavigationCommandId } from '@swf/navigation';
  import { CAPABILITY_ORDER, EXPERIMENTS, EXPERIMENT_IDS } from '@swf/navigation';
  import type { NavigationMessageId } from './messages.js';
  import type { NavigationModel } from './model.svelte.js';

  interface Props {
    model: NavigationModel;
  }

  let { model }: Props = $props();
  const t = (id: NavigationMessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);
  /** Settings said under their own fields when refused. */
  const NUMBER_FIELDS = ['depth.full', 'depth.compact', 'snap.linear', 'snap.angular', 'snap.padding', 'snap.spoke', 'snap.ring'];
  const round = (value: number, digits: number) => Number(value.toFixed(digits));

  const status = $derived(model.policies);
  const enabled = $derived(status?.features.enabled ?? null);

  function toggle(feature: FeatureId, on: boolean): void {
    void model.run('swf.feature.set', { feature, enabled: on });
  }

  function choose(experiment: ExperimentId): void {
    void model.run('swf.experiment.run', { experiment });
  }

  /** An experiment by its number and name. */
  const named = (id: ExperimentId) => `${EXPERIMENTS[id].number} ${t(EXPERIMENTS[id].name)}`;

  /** The capabilities with settings of their own, each in a section under the switches. */
  type Setting = 'orbit' | 'depth' | 'cursor' | 'snap' | 'persistence';
  const SETTINGS: readonly Setting[] = ['orbit', 'depth', 'cursor', 'snap', 'persistence'];
  /** What each such section says the capability does. */
  const DETAIL: Readonly<Record<Setting, NavigationMessageId>> = {
    orbit: 'orbit.detail',
    depth: 'depth.detail',
    cursor: 'cursor.detail',
    snap: 'snap.detail',
    persistence: 'persistence.detail',
  };
  /** What is so while it is off (workspace rotation says it with what drags turn). */
  const OFF: Readonly<Record<Exclude<Setting, 'orbit'>, NavigationMessageId>> = {
    depth: 'depth.off',
    cursor: 'cursor.off',
    snap: 'snap.off',
    persistence: 'persistence.off',
  };

  /** The experiment the switches are now, or null for a custom combination. */
  const current = $derived(model.experiment);
  /** What the head of the panel says: the experiment and how to try it, or the custom combination. */
  const context = $derived.by(() => {
    if (enabled === null) {
      return null;
    }
    if (current !== null) {
      return {
        title:
          current === 'everything'
            ? t(EXPERIMENTS.everything.name)
            : t('experiments.current', {
                number: EXPERIMENTS[current].number,
                name: t(EXPERIMENTS[current].name),
              }),
        detail: t(EXPERIMENTS[current].trial),
      };
    }
    const on = CAPABILITY_ORDER.filter((feature) => enabled[feature]).map((feature) =>
      t(EXPERIMENTS[feature].name),
    );
    return {
      title: t('experiments.custom'),
      detail: t('experiments.custom.trial', {
        on: on.length === 0 ? t('experiments.custom.none') : on.join(', '),
      }),
    };
  });

  const scene = $derived(model.orbitScene);

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
  function problem(command: NavigationCommandId, field: string): string | undefined {
    const refusal = model.refusal;
    return refusal !== null && refusal.command === command && refusal.field === field
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
  command: NavigationCommandId,
  field: string,
  disabled: boolean,
  apply: (value: number) => Promise<boolean>,
)}
  {@const message = problem(command, field)}
  {#snippet control()}
    <Input
      handle={handleOf`page.experiments.${key}`}
      id={`swf-${key}`}
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
    for={`swf-${key}`}
    {control}
    {hint}
    {...message === undefined ? {} : { message, messageTone: 'danger' as const }}
  />
{/snippet}

{#snippet orbitSettings()}
  {#if status !== null && enabled !== null && enabled.orbit}
    {#snippet navigationControl()}
      <Segmented
        handle={handleOf`page.experiments.orbit.navigation`}
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
          void model.run('swf.navigation.set', {
            target: target as 'camera' | 'orbit',
          });
        }}
      />
    {/snippet}
    <Field label={t('orbit.navigation')} group control={navigationControl} />
    {#snippet groupControl()}
      <Select
        handle={handleOf`page.experiments.orbit.group`}
        id="swf-orbit-group"
        options={[{ value: '', label: t('orbit.group.none') }, ...(scene?.groups ?? [])]}
        value={scene?.rootId ?? ''}
        onchange={(value) => {
          void model.run('swf.orbit.designate', { id: value === '' ? null : value });
        }}
      />
    {/snippet}
    <Field label={t('orbit.group')} for="swf-orbit-group" control={groupControl} />
    <Stack direction="row" gap="small" wrap>
      <Button
        handle={handleOf`page.experiments.orbit.left`}
        label={t('orbit.turn.left')}
        disabled={status.orbit.rootId === null}
        onpress={() => {
          void model.run('swf.orbit.turn', { degrees: -15 });
        }}
      />
      <Button
        handle={handleOf`page.experiments.orbit.right`}
        label={t('orbit.turn.right')}
        disabled={status.orbit.rootId === null}
        onpress={() => {
          void model.run('swf.orbit.turn', { degrees: 15 });
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
{/snippet}

<Panel title={t('experiments.title')} titled={false} handle={handleOf`page.experiments`}>
  {#if status !== null && enabled !== null && context !== null}
    <Stack inset gap="large">
      {#if model.refusal !== null && model.placeOf(model.refusal) === 'experiments' && !NUMBER_FIELDS.includes(model.refusal.field)}
        <Notice
          tone="danger"
          title={model.refusalText(model.refusal)}
          handle={handleOf`page.experiments.refusal`}
        />
      {/if}
      <Notice title={context.title} detail={context.detail} handle={handleOf`page.experiments.current`} />

      <Section title={t('experiments.list')} detail={t('experiments.list.detail')} handle={handleOf`page.experiments.list`}>
        <List ariaLabel={t('experiments.list')}>
          {#each EXPERIMENT_IDS as id (id)}
            <ListItem
              title={named(id)}
              description={t(EXPERIMENTS[id].summary)}
              current={current === id}
              handle={keyed('page.experiments.run', id)}
              onpress={() => {
                choose(id);
              }}
            />
          {/each}
        </List>
      </Section>

      <Section title={t('experiments.switches')} detail={t('experiments.switches.detail')} handle={handleOf`page.experiments.switches`}>
        <Stack gap="small">
          {#each CAPABILITY_ORDER as feature (feature)}
            <Checkbox
              handle={handleOf`page.experiments.${feature}.enabled`}
              id={`swf-${feature}-enabled`}
              label={named(feature)}
              checked={enabled[feature]}
              onchange={(on) => {
                toggle(feature, on);
              }}
            />
          {/each}
        </Stack>
      </Section>

      {#each SETTINGS as feature (feature)}
        <Section title={named(feature)} detail={t(DETAIL[feature])} handle={handleOf`page.experiments.${feature}`}>
          <Stack gap="small">
            {#if feature !== 'orbit' && !enabled[feature]}
              <Text quiet>{t(OFF[feature])}</Text>
            {/if}
            {#if feature === 'orbit'}
              {@render orbitSettings()}
            {:else if feature === 'depth' && enabled.depth}
              {@render numberField('depth-full', t('depth.full'), t('depth.full.hint'), status.features.depth.full, 'swf.depth.configure', 'depth.full', false, (full) =>
                model.run('swf.depth.configure', { full }),
              )}
              {@render numberField('depth-compact', t('depth.compact'), t('depth.compact.hint'), status.features.depth.compact, 'swf.depth.configure', 'depth.compact', false, (compact) =>
                model.run('swf.depth.configure', { compact }),
              )}
            {:else if feature === 'cursor' && enabled.cursor}
              <Notice tone="info" title={t('cursor.limits')} handle={handleOf`page.experiments.cursor.limits`} />
              {#if !status.wraps}
                <Text quiet>{t('cursor.unavailable')}</Text>
              {/if}
            {:else if feature === 'snap' && enabled.snap}
              {@render numberField('snap-linear', t('snap.linear'), t('snap.linear.hint'), status.features.snap.linear, 'swf.snap.configure', 'snap.linear', false, (linear) =>
                model.run('swf.snap.configure', { linear }),
              )}
              {@render numberField('snap-angular', t('snap.angular'), t('snap.angular.hint'), status.features.snap.angular, 'swf.snap.configure', 'snap.angular', false, (angular) =>
                model.run('swf.snap.configure', { angular }),
              )}
              {@render numberField('snap-padding', t('snap.padding'), t('snap.padding.hint'), status.features.snap.padding, 'swf.snap.configure', 'snap.padding', false, (padding) =>
                model.run('swf.snap.configure', { padding }),
              )}
              {@render numberField('snap-spoke', t('snap.spoke'), t('snap.spoke.hint'), status.features.snap.spoke, 'swf.snap.configure', 'snap.spoke', false, (spoke) =>
                model.run('swf.snap.configure', { spoke }),
              )}
              {@render numberField('snap-ring', t('snap.ring'), t('snap.ring.hint'), status.features.snap.ring, 'swf.snap.configure', 'snap.ring', false, (ring) =>
                model.run('swf.snap.configure', { ring }),
              )}
            {/if}
          </Stack>
        </Section>
      {/each}

      <Stack gap="small">
        <Stack direction="row" gap="small" wrap>
          <Button
            handle={handleOf`page.experiments.reset`}
            label={t('experiments.reset')}
            icon="undo"
            onpress={() => {
              typed = {};
              void model.run('swf.feature.reset', {});
            }}
          />
        </Stack>
        <Text quiet>{t('experiments.reset.detail')}</Text>
      </Stack>
    </Stack>
  {/if}
</Panel>
