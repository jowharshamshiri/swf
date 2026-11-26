<script lang="ts">
  // THE GUIDED SCENARIOS AND THE TIMED TASK. A scenario walks through one of the framework's
  // principal behaviours in the studio scene: its steps are listed, the one due says the ways to
  // do it and can be shown, and each is ticked off once it is done, however it was done. The task
  // names a window to find and times each run, kept with the way it was navigated so the ways
  // compare.
  import {
    Button,
    Facts,
    Field,
    List,
    ListItem,
    Notice,
    Panel,
    Section,
    Select,
    Stack,
    Table,
    Text,
  } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import type { MethodId } from '../challenge.js';
  import { METHOD_IDS, METHOD_NAMES, summarize } from '../challenge.js';
  import type { MessageId } from '../messages.js';
  import type { ScenarioId } from '../scenarios.js';
  import { SCENARIO_IDS, SCENARIO_LAYOUT, SCENARIOS } from '../scenarios.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  const current = $derived(model.scenario);
  const scenario = $derived(current === null ? null : SCENARIOS[current.scenario]);
  /** What the steps' words name: the depth bands as set, and the layout's name. */
  const params = $derived({
    full: model.policies?.features.depth.full ?? 0,
    compact: model.policies?.features.depth.compact ?? 0,
    name: SCENARIO_LAYOUT,
  });

  function start(id: ScenarioId): void {
    void model.run('reference.scenario.start', { scenario: id });
  }

  let method = $state<MethodId>('camera');
  const task = $derived(model.challenge);
  const run = $derived(task?.run ?? null);
  const methods = $derived(
    METHOD_IDS.map((id) => ({
      value: id,
      label: t(METHOD_NAMES[id]),
      disabled:
        (id === 'orbit' && model.policies?.features.enabled.orbit !== true) ||
        (id === 'map' && model.policies?.features.enabled.map !== true),
    })),
  );
  // The clock a run is timed by, read every tenth of a second while one is under way.
  let clock = $state(performance.now());
  $effect(() => {
    if (run === null) {
      return;
    }
    clock = performance.now();
    const ticking = setInterval(() => {
      clock = performance.now();
    }, 100);
    return () => {
      clearInterval(ticking);
    };
  });
  const seconds = (ms: number) => (ms / 1000).toFixed(2);
  const last = $derived(task === null ? null : (task.records.at(-1) ?? null));
  const summary = $derived(task === null ? [] : summarize(task.records));
</script>

{#snippet methodControl()}
  <Select
    handle={handleOf`page.challenge.method`}
    id="reference-challenge-method"
    options={methods}
    value={method}
    onchange={(value) => {
      method = value as MethodId;
    }}
  />
{/snippet}

<Panel title={t('scenarios.title')} titled={false} handle={handleOf`page.scenarios`}>
  <Stack inset gap="large">
    {#if model.refusal !== null && model.isScenarioRefusal(model.refusal)}
      <Notice
        tone="danger"
        title={model.refusalText(model.refusal)}
        handle={handleOf`page.scenarios.refusal`}
      />
    {/if}
    {#if current === null || scenario === null}
      <Section title={t('scenarios.list')} detail={t('scenarios.detail')} handle={handleOf`page.scenarios.list`}>
        <List ariaLabel={t('scenarios.list')}>
          {#each SCENARIO_IDS as id (id)}
            <ListItem
              title={t(SCENARIOS[id].name)}
              description={t(SCENARIOS[id].summary)}
              icon="resume"
              handle={keyed('page.scenarios.start', id)}
              onpress={() => {
                start(id);
              }}
            />
          {/each}
        </List>
      </Section>
    {:else}
      <Section
        title={t(scenario.name)}
        handle={handleOf`page.scenarios.current`}
        detail={current.finished
          ? t('scenarios.finished')
          : t('scenarios.progress', { step: current.done + 1, steps: current.steps })}
      >
        {#snippet actions()}
          <Button
            handle={handleOf`page.scenarios.again`}
            label={t('scenarios.again')}
            icon="refresh"
            size="small"
            onpress={() => {
              start(current.scenario);
            }}
          />
          <Button
            handle={handleOf`page.scenarios.stop`}
            label={t('scenarios.stop')}
            icon="stop"
            size="small"
            onpress={() => {
              void model.run('reference.scenario.stop', {});
            }}
          />
        {/snippet}
        <Text quiet>{t(scenario.summary)}</Text>
        <List ariaLabel={t('scenarios.steps')}>
          {#each scenario.steps as step, index (step.id)}
            {@const state =
              index < current.done ? 'done' : index === current.done ? 'due' : 'later'}
            <ListItem
              title={t(step.text, params)}
              detail={t(`scenarios.step.${state}`)}
              icon={state === 'done' ? 'success' : state === 'due' ? 'becomes' : 'status'}
              iconTone={state === 'done' ? 'success' : undefined}
              current={state === 'due'}
              muted={state === 'later'}
            />
          {/each}
        </List>
        {#if current.finished}
          <Notice tone="success" title={t('scenarios.finished')} handle={handleOf`page.scenarios.finished`} />
        {:else}
          {@const step = scenario.steps[current.done]}
          {#if step !== undefined}
            <Notice
              tone="info"
              title={t(step.text, params)}
              detail={t(step.hint, params)}
              handle={handleOf`page.scenarios.hint`}
            />
          {/if}
          <Stack direction="row" gap="small" wrap>
            <Button
              handle={handleOf`page.scenarios.show`}
              label={t('scenarios.show')}
              icon="resume"
              variant="primary"
              onpress={() => {
                void model.showStep();
              }}
            />
          </Stack>
        {/if}
        {#if model.scenarioProblem !== null}
          <Notice
            tone="danger"
            title={t('scenarios.cannot', { reason: model.scenarioProblem })}
            handle={handleOf`page.scenarios.problem`}
          />
        {/if}
      </Section>
    {/if}

    <Section title={t('challenge.title')} detail={t('challenge.detail')} handle={handleOf`page.challenge`}>
      <Field label={t('challenge.method')} for="reference-challenge-method" control={methodControl} />
      {#if run !== null}
        <Facts
          ariaLabel={t('challenge.title')}
          items={[
            { term: t('challenge.find'), value: run.label },
            { term: t('challenge.method'), value: t(METHOD_NAMES[run.method]) },
            {
              term: t('challenge.time'),
              value: t('challenge.seconds', { seconds: seconds(Math.max(0, clock - run.startedAt)) }),
            },
            { term: t('challenge.actions'), value: String(run.actions) },
          ]}
        />
      {:else if task?.ended === 'removed'}
        <Notice tone="warning" title={t('challenge.removed')} handle={handleOf`page.challenge.removed`} />
      {:else if last !== null}
        <Notice
          tone="success"
          title={t('challenge.found', {
            label: last.label,
            seconds: seconds(last.ms),
            actions: last.actions,
          })}
          handle={handleOf`page.challenge.found`}
        />
      {/if}
      <Stack direction="row" gap="small" wrap>
        <Button
          handle={handleOf`page.challenge.start`}
          label={run === null && (task?.records.length ?? 0) === 0 ? t('challenge.start') : t('challenge.again')}
          icon="resume"
          variant={run === null ? 'primary' : undefined}
          disabled={methods.find((m) => m.value === method)?.disabled ?? true}
          onpress={() => {
            void model.run('reference.challenge.start', { method });
          }}
        />
        {#if run !== null}
          <Button
            handle={handleOf`page.challenge.cancel`}
            label={t('challenge.cancel')}
            icon="stop"
            onpress={() => {
              void model.run('reference.challenge.cancel', {});
            }}
          />
        {/if}
      </Stack>
      {#if task !== null && task.records.length > 0}
        <Table
          ariaLabel={t('challenge.by.method')}
          caption={t('challenge.by.method')}
          columns={[
            { key: 'method', label: t('challenge.column.method') },
            { key: 'best', label: t('challenge.column.best'), align: 'end' },
            { key: 'mean', label: t('challenge.column.mean'), align: 'end' },
          ]}
          rows={summary.map((s) => ({
            key: s.method,
            cells: {
              method: {
                text: t(METHOD_NAMES[s.method]),
                detail: t('challenge.summary.detail', {
                  runs: s.runs,
                  actions: s.meanActions.toFixed(1),
                }),
              },
              best: { text: seconds(s.bestMs) },
              mean: { text: seconds(s.meanMs) },
            },
          }))}
        />
        <Table
          ariaLabel={t('challenge.runs')}
          caption={t('challenge.runs')}
          columns={[
            { key: 'method', label: t('challenge.column.method') },
            { key: 'time', label: t('challenge.column.time'), align: 'end' },
            { key: 'actions', label: t('challenge.column.actions'), align: 'end' },
          ]}
          rows={task.records
            .map((r, i) => ({
              key: String(i),
              cells: {
                method: { text: t(METHOD_NAMES[r.method]), detail: r.label },
                time: { text: seconds(r.ms) },
                actions: { text: String(r.actions) },
              },
            }))
            .reverse()}
        />
        <Button
          handle={handleOf`page.challenge.clear`}
          label={t('challenge.clear')}
          icon="delete"
          size="small"
          onpress={() => {
            void model.run('reference.challenge.clear', {});
          }}
        />
      {:else}
        <Text quiet>{t('challenge.runs.none')}</Text>
      {/if}
    </Section>
  </Stack>
</Panel>
