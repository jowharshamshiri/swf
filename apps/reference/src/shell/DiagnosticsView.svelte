<script lang="ts">
  // THE DEBUG OVERLAY of staging builds: what the running presentation reports locally, read
  // again with every frame. Production builds leave this view, and the diagnostics package with
  // it, out of the bundle.
  import { createDiagnostics } from '@swf/diagnostics';
  import type { DiagnosticsReport } from '@swf/diagnostics';
  import { Panel, Stack, Stat, StatGroup } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import type { MessageId } from '../messages.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId) => model.messages.format(id);
  const count = (value: number) => model.messages.number(value);

  let report = $state<DiagnosticsReport | null>(null);

  $effect(() => {
    const app = model.app;
    if (app === null) {
      return;
    }
    const diagnostics = createDiagnostics({
      workspace: app.workspace,
      runtime: app.runtime,
      presenter: app.presenter,
      registry: app.presentation,
    });
    const stop = app.presenter.subscribe((event) => {
      if (event.type === 'frame') {
        report = diagnostics.read();
      }
    });
    report = diagnostics.read();
    return () => {
      stop();
      diagnostics.dispose();
    };
  });

  const view = $derived(report?.density.viewports[0]);
  const bound = $derived(report?.attachments.reduce((sum, a) => sum + a.bound, 0) ?? 0);
  const failed = $derived(report?.attachments.reduce((sum, a) => sum + a.failed, 0) ?? 0);
</script>

<Panel title={t('diagnostics.title')} titled={false} handle={handleOf`page.diagnostics`}>
  {#if report !== null}
    <Stack inset>
      <StatGroup ariaLabel={t('diagnostics.label')}>
        <Stat label={t('diagnostics.candidates')} value={count(view?.candidates ?? 0)} />
        <Stat label={t('diagnostics.culled')} value={count(view?.culled ?? 0)} />
        <Stat label={t('diagnostics.bound')} value={count(bound)} />
        <Stat label={t('diagnostics.failed')} value={count(failed)} />
        <Stat
          label={t('diagnostics.subscriptions')}
          value={count(report.resources.subscriptions)}
        />
        <Stat label={t('diagnostics.errors')} value={count(report.errors.length)} />
      </StatGroup>
    </Stack>
  {/if}
</Panel>
