<script lang="ts">
  // WHAT IS SELECTED: the window's identity and where it is around the camera, in degrees and
  // world units, formatted for the reader's locale. The scene keeps its own numbers.
  import { EmptyState, Facts, Panel, Stack } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import type { MessageId } from '../messages.js';
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
</script>

<Panel title={t('inspector.title')} titled={false} handle={handleOf`page.inspector`}>
  {#if selected === null}
    <EmptyState icon="info" title={t('inspector.none')} detail={t('inspector.none.detail')} />
  {:else}
    <Stack inset>
      <Facts ariaLabel={t('inspector.label')} items={facts} />
    </Stack>
  {/if}
</Panel>
