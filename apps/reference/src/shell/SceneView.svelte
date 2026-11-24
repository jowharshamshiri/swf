<script lang="ts">
  // THE SCENE: which preset the workspace is seeded from, and from which seed; reset and reseed.
  import { Button, Field, Input, Notice, Panel, Select, Stack } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import type { MessageId } from '../messages.js';
  import type { PresetId } from '../presets.js';
  import { PRESET_IDS, PRESETS } from '../presets.js';
  import { seedIssue } from '@swf/math';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId) => model.messages.format(id);

  const status = $derived(model.status);
  let seedText = $state('');
  let seedInvalid = $state(false);
  // The seed field follows the scene until the reader types in it.
  $effect(() => {
    if (status !== null) {
      seedText = String(status.scene.seed);
      seedInvalid = false;
    }
  });

  function reseedFrom(text: string): void {
    const seed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    seedInvalid = seedIssue(seed) !== null;
    if (!seedInvalid) {
      void model.run('reference.scene.reseed', { seed });
    }
  }

  const presets = $derived(PRESET_IDS.map((id) => ({ value: id, label: t(PRESETS[id].name) })));
</script>

{#snippet presetControl()}
  <Select
    handle={handleOf`page.scene.preset`}
    id="reference-preset"
    options={presets}
    value={status?.scene.preset ?? 'sparse'}
    disabled={status === null}
    onchange={(value) => {
      void model.run('reference.preset.load', { preset: value as PresetId });
    }}
  />
{/snippet}

{#snippet seedControl()}
  <Input
    handle={handleOf`page.scene.seed`}
    id="reference-seed"
    type="number"
    min={0}
    max={4294967295}
    step={1}
    value={seedText}
    invalid={seedInvalid}
    disabled={status === null}
    oninput={(value) => {
      seedText = value;
    }}
    onchange={reseedFrom}
  />
{/snippet}

<Panel title={t('scene.title')} titled={false} handle={handleOf`page.scene`}>
  <Stack inset>
    <Field label={t('scene.preset')} for="reference-preset" control={presetControl} />
    <Field
      label={t('scene.seed')}
      for="reference-seed"
      control={seedControl}
      hint={t('scene.seed.hint')}
      {...seedInvalid ? { message: t('scene.seed.invalid'), messageTone: 'danger' as const } : {}}
    />
    <Stack direction="row" gap="small" wrap>
      <Button
        handle={handleOf`page.scene.reset`}
        label={t('command.scene.reset')}
        icon="undo"
        disabled={status === null}
        onpress={() => {
          void model.run('reference.scene.reset', {});
        }}
      />
      <Button
        handle={handleOf`page.scene.reseed`}
        label={t('command.scene.reseed')}
        icon="refresh"
        disabled={status === null}
        onpress={() => {
          void model.run('reference.scene.reseed', {});
        }}
      />
    </Stack>
    {#if model.refusal !== null && model.isSceneRefusal(model.refusal)}
      <Notice
        tone="danger"
        title={model.refusalText(model.refusal)}
        handle={handleOf`page.scene.refusal`}
      />
    {/if}
  </Stack>
</Panel>
