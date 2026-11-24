<script lang="ts">
  // ASKED BEFORE THE WORKSPACE IS REPLACED (FR-201, UX-016): what an imported file or a named
  // workspace holds, counted, and what it replaces; Replace or Cancel. Escape cancels.
  import { Button, Dialog, Facts, Stack, Text } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import type { MessageId } from '../messages.js';
  import type { PendingReplace, ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
    pending: PendingReplace;
  }

  let { model, pending }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  const preview = $derived(pending.preview);
  const what = $derived(
    pending.kind === 'import'
      ? t('replace.import', { file: pending.fileName })
      : t('replace.open', { name: pending.name }),
  );
  const created = $derived(
    new Intl.DateTimeFormat(model.messages.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      preview.createdAt,
    ),
  );
</script>

<Dialog
  title={t('replace.title')}
  handle={handleOf`page.replace`}
  onclose={() => {
    model.cancelReplace();
  }}
>
  <Stack gap="small">
    <Text>{what}</Text>
    <Facts
      ariaLabel={what}
      items={[
        { term: t('replace.windows'), value: model.messages.number(preview.windows) },
        { term: t('replace.groups'), value: model.messages.number(preview.groups) },
        { term: t('replace.surfaces'), value: model.messages.number(preview.surfaces) },
        { term: t('replace.viewports'), value: model.messages.number(preview.viewports) },
        { term: t('replace.created'), value: created },
        { term: t('replace.format'), value: preview.schema, literal: true },
        ...(preview.extensions.length === 0
          ? []
          : [{ term: t('replace.extensions'), value: preview.extensions.join(', '), literal: true }]),
      ]}
    />
    <Text quiet>{t('replace.current', { windows: model.status?.windows ?? 0 })}</Text>
  </Stack>
  {#snippet actions()}
    <Button
      handle={handleOf`page.replace.cancel`}
      label={t('replace.cancel')}
      onpress={() => {
        model.cancelReplace();
      }}
    />
    <Button
      handle={handleOf`page.replace.confirm`}
      label={t('replace.confirm')}
      variant="primary"
      onpress={() => {
        void model.confirmReplace();
      }}
    />
  {/snippet}
</Dialog>
