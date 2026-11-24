<script lang="ts">
  // THE DEVELOPER PANEL of staging builds and development (§22, DLV-010): the selected window as
  // the framework sees it (its transforms, each surface's binding, capabilities, fragments, tier,
  // occlusion and last error, the last input target and the frame's scheduling, with a debug
  // overlay over the panorama); the event timeline; the capability matrix; failure simulation; and
  // the measures, with the diagnostics and operation-trace exports, which disclose labels, binding
  // keys and the host's data only when chosen. It reads through public APIs only and changes the
  // scene only as a host would (ADM-001). Production builds leave it, and all it uses, out.
  import {
    Button,
    Checkbox,
    Disclosure,
    Facts,
    LogView,
    Notice,
    Panel,
    ScaledView,
    Section,
    Stack,
    Stat,
    StatGroup,
    Table,
    Text,
  } from '@wsb/uikit/components';
  import type { LogLine, TableRow } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import { worldMatrix } from '@swf/core';
  import { mat4Decompose } from '@swf/math';
  import { standInReason } from '@swf/presentation';
  import { onDestroy, untrack } from 'svelte';
  import { BACKEND_IDS } from '../config.js';
  import type { Devtools, SimulatedFailure } from '../devtools.js';
  import { createDevtools, SIMULATED_FAILURES } from '../devtools.js';
  import type { MessageId } from '../messages.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);
  const n = (value: number, digits = 3) => model.messages.number(Number(value.toFixed(digits)));
  const ms = (value: number | null) => (value === null ? '—' : t('dev.ms', { value: n(value, 2) }));

  /** Which sections are open: the selected window's first. */
  let sections = $state({
    inspect: true,
    events: false,
    capabilities: false,
    simulate: false,
    measures: false,
  });
  let tools = $state.raw<Devtools | null>(null);
  /** Rises whenever the tools have something new: what the panel reads follows it. */
  let version = $state(0);
  let secondSurface: HTMLElement | undefined = $state();
  let secondOpen = $state(false);
  let disclose = $state({ labels: false, bindingKeys: false, hostData: false, messages: false, timings: false });

  $effect(() => {
    const app = model.app;
    if (app === null) {
      return;
    }
    // Made untracked: making them registers adapters, which tells the shell's own state, and the
    // panel must not start again whenever that state changes.
    const made = untrack(() => createDevtools(app));
    tools = made;
    let queued = false;
    const stop = made.subscribe(() => {
      if (queued) {
        return;
      }
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        version += 1;
      });
    });
    const stopFrames = app.presenter.subscribe((event) => {
      if (event.type === 'frame') {
        version += 1;
      }
    });
    return () => {
      stop();
      stopFrames();
      tools = null;
      void made.dispose();
    };
  });
  onDestroy(() => {
    secondOpen = false;
  });

  /** The selected window as the framework has it. */
  const inspected = $derived.by(() => {
    void version;
    void model.revision;
    const app = model.app;
    const id = model.selected?.id ?? null;
    if (app === null || tools === null || id === null) {
      return null;
    }
    const state = app.workspace.getState();
    const node = state.nodes.get(id);
    if (node === undefined) {
      return null;
    }
    const world = worldMatrix(state.nodes, id);
    const decomposed = world === undefined ? null : mat4Decompose(world, 1e-6);
    const frame = app.viewport.lastFrame();
    const report = tools.diagnostics.read();
    const surfaces = node.surfaceIds.map((surfaceId) => {
      const record = state.surfaces.get(surfaceId);
      const presentation = app.runtime.get(surfaceId);
      const planned = frame?.frame.planned.filter((p) => p.fragment.surfaceId === surfaceId) ?? [];
      const hint = frame?.hints.find((h) => h.surfaceId === surfaceId) ?? null;
      const reported = [...report.errors].reverse().find((e) => e.error.entityId === surfaceId);
      const error = presentation?.error ?? reported?.error ?? null;
      return { surfaceId, record, presentation, planned, hint, error };
    });
    return { node, transform: decomposed?.ok === true ? decomposed.transform : null, surfaces };
  });

  const vec = (v: readonly number[]) => v.map((c) => n(c)).join(', ');
  /** A capability as read: a list by its items, a record as JSON, anything else as itself. */
  const shown = (value: unknown): string =>
    Array.isArray(value)
      ? value.map(shown).join(', ')
      : typeof value === 'object' && value !== null
        ? JSON.stringify(value)
        : String(value);

  const fragmentRows = (planned: NonNullable<typeof inspected>['surfaces'][number]['planned']): TableRow[] =>
    planned.map((p) => ({
      key: p.fragment.id,
      cells: {
        fragment: { text: `#${String(p.fragment.ordinal)}` },
        bounds: { text: p.fragment.bounds.map((b) => Math.round(b)).join(' ') },
        owner: { text: p.fragment.nativeOwner ? t('dev.fragment.owner') : t('dev.fragment.duplicate') },
        mode: { text: `${p.negotiation.mode} · ${p.negotiation.layer}` },
        fidelity: { text: `${p.negotiation.anchorFidelity} / ${p.negotiation.shapeFidelity}` },
        reason: { text: standInReason(p) ?? '—' },
      },
    }));

  const lastTarget = $derived.by(() => {
    void version;
    return tools?.input().lastTarget ?? null;
  });

  const timelineLines = $derived.by((): LogLine[] => {
    void version;
    return (tools?.timeline() ?? []).map((entry) => ({
      key: entry.seq,
      time: `${n(entry.at / 1000, 2)} s`,
      source: entry.origin,
      kind: entry.type.endsWith('rejected') || entry.type.endsWith('failed') || entry.type.endsWith('degraded') ? 'failure' : 'output',
      parts: [{ text: `${entry.type}  ${entry.detail}` }],
    }));
  });

  /** Capability fields down, adapter types across: what each kind of endpoint can do. */
  const matrix = $derived.by(() => {
    void version;
    const app = model.app;
    if (app === null) {
      return null;
    }
    const byType = new Map<string, Record<string, unknown> | null>();
    for (const surface of app.workspace.getState().surfaces.values()) {
      const capabilities = app.runtime.get(surface.id)?.capabilities ?? null;
      if (!byType.has(surface.adapterTypeId) || (byType.get(surface.adapterTypeId) === null && capabilities !== null)) {
        byType.set(surface.adapterTypeId, capabilities as Record<string, unknown> | null);
      }
    }
    const types = [...byType.keys()].sort();
    const fields = [
      ...new Set([...byType.values()].flatMap((c) => (c === null ? [] : Object.keys(c)))),
    ];
    return {
      columns: [
        { key: 'field', label: t('dev.capabilities.field') },
        ...types.map((type) => ({ key: type, label: type, literal: true })),
      ],
      rows: fields.map(
        (field): TableRow => ({
          key: field,
          cells: Object.fromEntries([
            ['field', { text: field }],
            ...types.map((type) => {
              const capabilities = byType.get(type);
              return [type, { text: capabilities == null ? t('dev.capabilities.unbound') : String(capabilities[field]) }];
            }),
          ]),
        }),
      ),
      backend: app.viewport.capabilities,
    };
  });

  const simulated = $derived.by(() => {
    void version;
    void model.revision;
    const app = model.app;
    if (app === null || tools === null) {
      return null;
    }
    const present = tools.simulated();
    return SIMULATED_FAILURES.map((failure) => {
      const id = present[failure];
      const surfaceId = id === undefined ? null : `${id}-surface`;
      const planned = surfaceId === null ? undefined : app.viewport.lastFrame()?.frame.planned.find((p) => p.fragment.surfaceId === surfaceId);
      return {
        failure,
        id,
        state: surfaceId === null ? null : (app.runtime.get(surfaceId)?.state ?? null),
        reason: planned === undefined ? null : standInReason(planned),
      };
    });
  });

  const removed = $derived.by(() => {
    void version;
    void model.status;
    return model.app?.removedBackends() ?? [];
  });

  const measures = $derived.by(() => {
    void version;
    void model.revision;
    if (tools === null || model.app === null) {
      return null;
    }
    return {
      report: tools.diagnostics.read(),
      input: tools.input(),
      navigation: tools.navigation(),
      persistence: model.app.workspaces.measures(),
    };
  });

  async function openSecond(): Promise<void> {
    secondOpen = true;
    // The second view's surface is drawn once it is asked for.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (tools !== null && secondSurface !== undefined) {
      await tools.openSecondView(secondSurface);
    }
  }

  async function closeSecond(): Promise<void> {
    await tools?.closeSecondView();
    secondOpen = false;
  }

  const DISCLOSURES = ['labels', 'bindingKeys', 'hostData', 'messages', 'timings'] as const;
</script>

{#snippet secondSurfaceView()}
  <ScaledView
    ariaLabel={t('dev.second.label')}
    handle={handleOf`page.developer.second.view`}
    natural={{ width: 240, height: 120 }}
    bind:surface={secondSurface}
  />
{/snippet}

<Panel title={t('dev.title')} titled={false} handle={handleOf`page.developer`}>
  <Stack inset gap="large">

    <Disclosure
      handle={keyed('page.developer.section', 'inspect')}
      title={t('dev.inspect')}
      open={sections.inspect}
      ontoggle={(on) => {
        sections = { ...sections, inspect: on };
      }}
    >
      <Stack gap="small">
      <Checkbox
        handle={handleOf`page.developer.overlay`}
        id="reference-debug-overlay"
        label={t('dev.overlay')}
        detail={t('dev.overlay.detail')}
        checked={tools?.overlayShown() ?? false}
        onchange={(on) => {
          tools?.showOverlay(on);
        }}
      />
      {#if inspected === null}
        <Text quiet>{t('inspector.none.detail')}</Text>
      {:else}
        <Section title={t('dev.transform')} handle={handleOf`page.developer.transform`}>
          <Facts
            ariaLabel={t('dev.transform')}
            items={[
              { term: t('dev.transform.world.position'), value: inspected.transform === null ? '—' : vec(inspected.transform.position), literal: true },
              { term: t('dev.transform.world.rotation'), value: inspected.transform === null ? '—' : vec(inspected.transform.rotation), literal: true },
              { term: t('dev.transform.local.position'), value: vec(inspected.node.transform.position), literal: true },
              { term: t('dev.transform.local.rotation'), value: vec(inspected.node.transform.rotation), literal: true },
              { term: t('dev.transform.scale'), value: vec(inspected.node.transform.scale), literal: true },
              { term: t('dev.transform.parent'), value: inspected.node.parentId ?? '—', literal: true },
            ]}
          />
        </Section>
        {#each inspected.surfaces as surface (surface.surfaceId)}
          <Section title={surface.surfaceId} handle={keyed('page.developer.surface', surface.surfaceId)}>
            <Stack gap="small">
              <Facts
                ariaLabel={surface.surfaceId}
                items={[
                  { term: t('dev.binding.adapter'), value: surface.record?.adapterTypeId ?? '—', literal: true },
                  { term: t('dev.binding.key'), value: surface.record?.bindingKey ?? '—', literal: true },
                  {
                    term: t('dev.binding.state'),
                    value: surface.presentation === undefined
                      ? '—'
                      : `${surface.presentation.state}${surface.presentation.unboundReason === null ? '' : ` (${surface.presentation.unboundReason})`} · ${t('dev.binding.generation', { value: surface.presentation.generation })}`,
                  },
                  {
                    term: t('dev.tier'),
                    value: surface.hint === null ? '—' : `${surface.hint.tier} · ${surface.hint.attention}`,
                  },
                  {
                    term: t('dev.occlusion'),
                    value: surface.hint === null
                      ? '—'
                      : `${surface.hint.occlusion.value === null ? '—' : n(surface.hint.occlusion.value, 2)} (${surface.hint.occlusion.confidence})`,
                  },
                  {
                    term: t('dev.visibility'),
                    value: surface.hint === null
                      ? '—'
                      : t('dev.visibility.value', {
                          visible: String(surface.hint.visible),
                          mounted: String(surface.hint.mounted),
                          ratio: n(surface.hint.intersectionRatio, 2),
                        }),
                  },
                  {
                    term: t('dev.error'),
                    value: surface.error === null ? '—' : `${surface.error.code}: ${surface.error.message}`,
                  },
                ]}
              />
              {#if surface.planned.length > 0}
                <Table
                  ariaLabel={t('dev.fragments')}
                  caption={t('dev.fragments')}
                  columns={[
                    { key: 'fragment', label: t('dev.fragment') },
                    { key: 'bounds', label: t('dev.fragment.bounds'), literal: true },
                    { key: 'owner', label: t('dev.fragment.role') },
                    { key: 'mode', label: t('dev.fragment.mode') },
                    { key: 'fidelity', label: t('dev.fragment.fidelity') },
                    { key: 'reason', label: t('dev.fragment.reason') },
                  ]}
                  rows={fragmentRows(surface.planned)}
                />
              {:else}
                <Text quiet>{t('dev.fragments.none')}</Text>
              {/if}
              {#if surface.presentation?.capabilities != null}
                <Facts
                  ariaLabel={t('dev.capabilities')}
                  items={Object.entries(surface.presentation.capabilities).map(([term, value]) => ({
                    term,
                    value: String(value),
                    literal: true,
                  }))}
                />
              {/if}
            </Stack>
          </Section>
        {/each}
      {/if}
      <Section title={t('dev.target')} handle={handleOf`page.developer.target`}>
        {#if lastTarget === null}
          <Text quiet>{t('dev.target.none')}</Text>
        {:else}
          <Facts
            ariaLabel={t('dev.target')}
            items={[
              { term: t('dev.target.at'), value: `${lastTarget.viewportId} (${n(lastTarget.x, 1)}, ${n(lastTarget.y, 1)})`, literal: true },
              { term: t('dev.target.hit'), value: lastTarget.surfaceId ?? lastTarget.nodeId ?? t('dev.target.background'), literal: true },
              { term: t('dev.target.region'), value: `${lastTarget.region ?? '—'} · ${lastTarget.route}${lastTarget.ambiguous ? ` · ${t('dev.target.ambiguous')}` : ''}` },
            ]}
          />
        {/if}
      </Section>
      <Section title={t('dev.scheduling')} handle={handleOf`page.developer.scheduling`}>
        {#if model.frame === null}
          <Text quiet>{t('status.pending')}</Text>
        {:else}
          <Facts
            ariaLabel={t('dev.scheduling')}
            items={[
              { term: t('dev.scheduling.duration'), value: ms(model.frame.durationMs) },
              { term: t('dev.scheduling.skipped'), value: n(model.frame.skipped, 0) },
              { term: t('dev.scheduling.dirty'), value: model.frame.dirty.join(', ') || '—' },
              { term: t('dev.scheduling.fragments'), value: n(model.frame.fragments, 0) },
              { term: t('dev.scheduling.live'), value: n(model.frame.live, 0) },
              { term: t('dev.scheduling.writes'), value: n(model.frame.writes, 0) },
              { term: t('dev.scheduling.hints'), value: n(model.frame.hints, 0) },
              { term: t('dev.scheduling.revision'), value: n(model.frame.sceneRevision, 0) },
            ]}
          />
        {/if}
      </Section>
      </Stack>
    </Disclosure>
    <Disclosure
      handle={keyed('page.developer.section', 'events')}
      title={t('dev.events')}
      open={sections.events}
      ontoggle={(on) => {
        sections = { ...sections, events: on };
      }}
    >
      <Stack gap="small">
      <LogView
        ariaLabel={t('dev.events')}
        handle={handleOf`page.developer.timeline`}
        lines={timelineLines}
        variant="tail"
        live
        waiting={t('dev.events.none')}
      />
      </Stack>
    </Disclosure>
    <Disclosure
      handle={keyed('page.developer.section', 'capabilities')}
      title={t('dev.capabilities')}
      open={sections.capabilities}
      ontoggle={(on) => {
        sections = { ...sections, capabilities: on };
      }}
    >
      <Stack gap="small">
      {#if matrix !== null}
        <Table ariaLabel={t('dev.capabilities')} caption={t('dev.capabilities.surfaces')} columns={matrix.columns} rows={matrix.rows} />
        {#if matrix.backend !== null}
          <Facts
            ariaLabel={t('dev.capabilities.backend')}
            items={[
              ...Object.entries(matrix.backend.renderer).map(([term, value]) => ({
                term: `renderer.${term}`,
                value: shown(value),
                literal: true,
              })),
              ...Object.entries(matrix.backend.compositor).map(([term, value]) => ({
                term: `compositor.${term}`,
                value: shown(value),
                literal: true,
              })),
            ]}
          />
        {/if}
      {/if}
      </Stack>
    </Disclosure>
    <Disclosure
      handle={keyed('page.developer.section', 'simulate')}
      title={t('dev.simulate')}
      open={sections.simulate}
      ontoggle={(on) => {
        sections = { ...sections, simulate: on };
      }}
    >
      <Stack gap="small">
      <Text quiet>{t('dev.simulate.detail')}</Text>
      {#if simulated !== null}
        {#each simulated as entry (entry.failure)}
          <Section title={t(`dev.simulate.${entry.failure}`)} handle={keyed('page.developer.simulate', entry.failure)}>
            <Stack gap="small">
              {#if entry.id === undefined}
                <Stack direction="row">
                  <Button
                    handle={keyed('page.developer.simulate.add', entry.failure)}
                    label={t('dev.simulate.add')}
                    size="small"
                    onpress={() => {
                      tools?.simulate(entry.failure as SimulatedFailure);
                    }}
                  />
                </Stack>
              {:else}
                <Text>{t('dev.simulate.state', { state: entry.state ?? '—', reason: entry.reason === null ? '—' : t(`standIn.${entry.reason}`) })}</Text>
                <Stack direction="row">
                  <Button
                    handle={keyed('page.developer.simulate.recover', entry.failure)}
                    label={t(`dev.simulate.recover.${entry.failure}`)}
                    size="small"
                    onpress={() => {
                      void tools?.recover(entry.failure as SimulatedFailure);
                    }}
                  />
                </Stack>
              {/if}
            </Stack>
          </Section>
        {/each}
        <Stack direction="row">
          <Button
            handle={handleOf`page.developer.simulate.clear`}
            label={t('dev.simulate.clear')}
            size="small"
            onpress={() => {
              tools?.clearSimulated();
            }}
          />
        </Stack>
      {/if}
      <Section title={t('dev.second')} detail={t('dev.second.detail')} handle={handleOf`page.developer.second`}>
        <Stack gap="small">
          <Stack direction="row">
            {#if secondOpen}
              <Button
                handle={handleOf`page.developer.second.close`}
                label={t('dev.second.close')}
                size="small"
                onpress={() => {
                  void closeSecond();
                }}
              />
            {:else}
              <Button
                handle={handleOf`page.developer.second.open`}
                label={t('dev.second.open')}
                size="small"
                onpress={() => {
                  void openSecond();
                }}
              />
            {/if}
          </Stack>
          {#if secondOpen}
            {@render secondSurfaceView()}
          {/if}
        </Stack>
      </Section>
      <Section title={t('dev.renderers')} detail={t('dev.renderers.detail')} handle={handleOf`page.developer.renderers`}>
        <Stack direction="row" gap="small" wrap>
          {#each BACKEND_IDS as backend (backend)}
            {#if removed.includes(backend)}
              <Button
                handle={keyed('page.developer.renderer.restore', backend)}
                label={t('dev.renderer.restore', { backend: t(`backend.${backend}`) })}
                size="small"
                onpress={() => {
                  void model.app?.restoreBackend(backend);
                }}
              />
            {:else}
              <Button
                handle={keyed('page.developer.renderer.remove', backend)}
                label={t('dev.renderer.remove', { backend: t(`backend.${backend}`) })}
                size="small"
                onpress={() => {
                  model.app?.removeBackend(backend);
                }}
              />
            {/if}
          {/each}
        </Stack>
      </Section>
      </Stack>
    </Disclosure>
    <Disclosure
      handle={keyed('page.developer.section', 'measures')}
      title={t('dev.measures')}
      open={sections.measures}
      ontoggle={(on) => {
        sections = { ...sections, measures: on };
      }}
    >
      <Stack gap="small">
      {#if measures !== null}
      {@const view = measures.report.density.viewports[0]}
      <StatGroup ariaLabel={t('diagnostics.label')}>
        <Stat label={t('diagnostics.candidates')} value={n(view?.candidates ?? 0, 0)} />
        <Stat label={t('diagnostics.culled')} value={n(view?.culled ?? 0, 0)} />
        <Stat label={t('diagnostics.bound')} value={n(measures.report.attachments.reduce((sum, a) => sum + a.bound, 0), 0)} />
        <Stat label={t('diagnostics.failed')} value={n(measures.report.attachments.reduce((sum, a) => sum + a.failed, 0), 0)} />
        <Stat label={t('diagnostics.subscriptions')} value={n(measures.report.resources.subscriptions, 0)} />
        <Stat label={t('diagnostics.errors')} value={n(measures.report.errors.length, 0)} />
      </StatGroup>
      <Table
        ariaLabel={t('dev.operations')}
        caption={t('dev.operations')}
        columns={[
          { key: 'type', label: t('dev.operations.type'), literal: true },
          { key: 'committed', label: t('dev.operations.committed'), align: 'end' },
          { key: 'rejected', label: t('dev.operations.rejected'), align: 'end' },
          { key: 'nodes', label: t('dev.operations.nodes'), align: 'end' },
          { key: 'last', label: t('dev.operations.last'), align: 'end' },
          { key: 'max', label: t('dev.operations.max'), align: 'end' },
        ]}
        rows={measures.report.operations.map((o) => ({
          key: o.commandType,
          cells: {
            type: { text: o.commandType },
            committed: { text: n(o.committed, 0) },
            rejected: { text: n(o.rejected, 0) },
            nodes: { text: n(o.affectedNodes, 0) },
            last: { text: ms(o.lastDurationMs) },
            max: { text: ms(o.maxDurationMs) },
          },
        }))}
      />
      <Facts
        ariaLabel={t('dev.input')}
        items={[
          { term: t('dev.input.dispatches'), value: n(measures.input.dispatches, 0) },
          { term: t('dev.input.picks'), value: t('dev.input.picks.value', { picks: n(measures.input.picks, 0), ambiguous: n(measures.input.ambiguous, 0) }) },
          { term: t('dev.input.pickTime'), value: `${ms(measures.input.lastPickMs)} / ${ms(measures.input.maxPickMs)}` },
          { term: t('dev.input.cancels'), value: Object.entries(measures.input.cancels).map(([k, v]) => `${k} ${String(v)}`).join(', ') || '—' },
          { term: t('dev.navigation.transitions'), value: Object.entries(measures.navigation.transitions).map(([k, v]) => `${k} ${String(v)}`).join(', ') || '—' },
          { term: t('dev.navigation.focus'), value: ms(measures.navigation.focusTimes.last) },
          { term: t('dev.navigation.travel'), value: t('dev.px', { value: n(measures.navigation.travelPx, 0) }) },
          { term: t('dev.persistence.bytes'), value: measures.persistence.lastSnapshotBytes === null ? '—' : n(measures.persistence.lastSnapshotBytes, 0) },
          { term: t('dev.persistence.times'), value: `${ms(measures.persistence.lastSaveMs)} / ${ms(measures.persistence.lastCaptureMs)} / ${ms(measures.persistence.lastSerializeMs)} / ${ms(measures.persistence.lastRestoreMs)}` },
          { term: t('dev.persistence.counts'), value: t('dev.persistence.counts.value', { saves: measures.persistence.saves, failed: measures.persistence.saveFailures, restores: measures.persistence.restores, restoreFailed: measures.persistence.restoreFailures }) },
        ]}
      />
      <Section title={t('dev.export')} detail={t('dev.export.detail')} handle={handleOf`page.developer.export`}>
        <Stack gap="small">
          {#each DISCLOSURES as field (field)}
            <Checkbox
              handle={keyed('page.developer.disclose', field)}
              id={`reference-disclose-${field}`}
              label={t(`dev.disclose.${field}`)}
              checked={disclose[field]}
              onchange={(on) => {
                disclose = { ...disclose, [field]: on };
              }}
            />
          {/each}
          {#if Object.values(disclose).some((on) => on)}
            <Notice tone="warning" title={t('dev.export.disclosing')} handle={handleOf`page.developer.export.disclosing`} />
          {/if}
          <Stack direction="row" gap="small" wrap>
            <Button
              handle={handleOf`page.developer.export.diagnostics`}
              label={t('dev.export.diagnostics')}
              icon="export"
              size="small"
              onpress={() => {
                if (tools !== null) {
                  model.app?.saveFile('diagnostics.json', tools.exportDiagnostics(disclose));
                }
              }}
            />
            <Button
              handle={handleOf`page.developer.export.trace`}
              label={t('dev.export.trace')}
              icon="export"
              size="small"
              onpress={() => {
                if (tools !== null) {
                  model.app?.saveFile('operation-trace.json', tools.trace.serialize(disclose));
                }
              }}
            />
          </Stack>
        </Stack>
      </Section>
      {/if}
      </Stack>
    </Disclosure>
  </Stack>
</Panel>
