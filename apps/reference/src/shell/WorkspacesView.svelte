<script lang="ts">
  // THE SPACES SAVED IN THIS BROWSER (FR-127, FR-168, UX-016, PRIV-002): how saving as the
  // space shown changes stands; saving what is on screen as a space of the operator's; the
  // spaces, each shown in one press, an operator's deleted and a seeded one reset (after it is
  // confirmed); exporting to a file and importing from one (previewed and confirmed); resetting to
  // the demo; and deleting every layout the application saved here, which says what it does not
  // touch.
  import {
    Button,
    Field,
    IconButton,
    Input,
    List,
    ListItem,
    Notice,
    Panel,
    Section,
    Stack,
    Text,
  } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import type { SpaceEntry } from '@swf/persistence';
  import { DEFAULT_CONFIG } from '../config.js';
  import type { MessageId } from '../messages.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  const on = $derived(model.policies?.features.enabled.persistence ?? false);
  const status = $derived(model.workspaces);
  let name = $state('');
  let confirmingDelete = $state(false);
  /** The seeded space whose reset waits to be confirmed, or null. */
  let confirmingReset = $state<string | null>(null);
  let picker: HTMLInputElement | undefined = $state();

  const saveText = $derived.by(() => {
    if (status === null) {
      return '';
    }
    if (!status.autosave) {
      return t('save.off');
    }
    switch (status.save) {
      case 'clean':
        return t('save.clean');
      case 'dirty':
        return t('save.dirty');
      case 'saving':
        return t('save.saving');
      case 'failed':
        return t('save.failed', { reason: status.saveError?.message ?? '' });
    }
  });

  const when = (at: number) =>
    new Intl.DateTimeFormat(model.messages.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(at);
  const size = (bytes: number) =>
    t('workspaces.bytes', { value: Math.max(1, Math.round(bytes / 1024)) });
  /** When a space was saved and how large it is, or that it is as seeded. */
  const entryText = (space: SpaceEntry) =>
    space.stored === null
      ? t('workspaces.entry.seeded')
      : t('workspaces.entry', { when: when(space.stored.savedAt), size: size(space.stored.bytes) });

  const refusal = $derived(
    model.refusal !== null && model.isWorkspaceRefusal(model.refusal) ? model.refusal : null,
  );

  async function onfile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file !== undefined) {
      model.beginImport(file.name, await file.text());
    }
  }
</script>

{#snippet nameControl()}
  <Input
    handle={handleOf`page.workspaces.name`}
    id="reference-workspace-name"
    value={name}
    oninput={(value) => {
      name = value;
    }}
  />
{/snippet}

<Panel title={t('workspaces.title')} titled={false} handle={handleOf`page.workspaces`}>
  <Stack inset gap="large">
    {#if !on}
      <Notice tone="info" title={t('workspaces.off')} handle={handleOf`page.workspaces.off`} />
    {:else}
      <Stack gap="small">
        <Text>{saveText}</Text>
        <Text quiet>{t('workspaces.autosave')}</Text>
      </Stack>
      {#if refusal !== null}
        <Notice tone="danger" title={model.refusalText(refusal)} handle={handleOf`page.workspaces.refusal`} />
      {/if}
      {#if model.workspaceNote !== null}
        {@const note = model.workspaceNote}
        <Notice
          tone={note.kind === 'problem' ? 'danger' : 'success'}
          title={note.kind === 'problem'
            ? note.text
            : note.kind === 'saved'
              ? t('workspaces.saved', { name: note.name })
              : note.kind === 'opened'
                ? t('restore.done', { name: note.name })
                : note.kind === 'deleted'
                  ? t('workspaces.deleted', { name: note.name })
                  : note.kind === 'reset'
                    ? t('workspaces.reset.done', { name: note.name })
                    : t('workspaces.deleteAll.done')}
          handle={handleOf`page.workspaces.note`}
        />
      {/if}

      <Section title={t('workspaces.named')} handle={handleOf`page.workspaces.named`}>
        <Stack gap="small">
          <Field
            label={t('workspaces.name')}
            for="reference-workspace-name"
            control={nameControl}
            hint={t('workspaces.name.hint')}
          />
          <Stack direction="row">
            <Button
              handle={handleOf`page.workspaces.save`}
              label={t('workspaces.save')}
              icon="save"
              disabled={name.trim() === ''}
              onpress={() => {
                void model.saveAs(name.trim()).then((done) => {
                  if (done) {
                    name = '';
                  }
                });
              }}
            />
          </Stack>
          <List ariaLabel={t('workspaces.named')}>
            {#each model.spaces as space (space.name)}
              {@const shown = space.name === status?.space}
              <ListItem
                title={space.name}
                detail={shown
                  ? t('workspaces.entry.shown', { state: entryText(space) })
                  : entryText(space)}
                icon={shown ? 'folder-open' : 'folder'}
                current={shown}
                handle={keyed('page.workspaces.entry', space.name)}
                onpress={() => {
                  void model.switchTo(space.name);
                }}
              >
                {#snippet actions()}
                  {#if !shown}
                    <IconButton
                      handle={keyed('page.workspaces.open', space.name)}
                      icon="show"
                      label={t('workspaces.open')}
                      size="small"
                      onpress={() => {
                        void model.switchTo(space.name);
                      }}
                    />
                  {/if}
                  {#if space.seeded}
                    <IconButton
                      handle={keyed('page.workspaces.reset', space.name)}
                      icon="undo"
                      label={t('workspaces.reset')}
                      size="small"
                      onpress={() => {
                        confirmingReset = space.name;
                      }}
                    />
                  {:else if !shown}
                    <IconButton
                      handle={keyed('page.workspaces.delete', space.name)}
                      icon="delete"
                      label={t('workspaces.delete')}
                      size="small"
                      onpress={() => {
                        void model.removeSpace(space.name, false);
                      }}
                    />
                  {/if}
                {/snippet}
              </ListItem>
            {/each}
          </List>
          {#if confirmingReset !== null}
            {@const resetting = confirmingReset}
            <Stack gap="small">
              <Text>{t('workspaces.reset.confirm', { name: resetting })}</Text>
              <Stack direction="row" gap="small">
                <Button
                  handle={handleOf`page.workspaces.reset.confirm`}
                  label={t('workspaces.reset')}
                  variant="danger"
                  icon="undo"
                  onpress={() => {
                    confirmingReset = null;
                    void model.removeSpace(resetting, true);
                  }}
                />
                <Button
                  handle={handleOf`page.workspaces.reset.cancel`}
                  label={t('replace.cancel')}
                  onpress={() => {
                    confirmingReset = null;
                  }}
                />
              </Stack>
            </Stack>
          {/if}
        </Stack>
      </Section>

      <Section title={t('workspaces.files')} detail={t('workspaces.files.detail')} handle={handleOf`page.workspaces.files`}>
        <Stack direction="row" gap="small" wrap>
          <Button
            handle={handleOf`page.workspaces.export`}
            label={t('workspaces.export')}
            icon="export"
            onpress={() => {
              void model.run('reference.workspace.export', {});
            }}
          />
          <Button
            handle={handleOf`page.workspaces.import`}
            label={t('workspaces.import')}
            icon="folder-open"
            onpress={() => {
              picker?.click();
            }}
          />
        </Stack>
        <!-- The platform's file chooser, opened by the kit's button above; it is never shown. -->
        <input
          bind:this={picker}
          type="file"
          accept=".json,application/json"
          hidden
          tabindex="-1"
          aria-hidden="true"
          data-reference-import
          onchange={(event) => {
            void onfile(event);
          }}
        />
      </Section>

      <Section title={t('workspaces.demo')} detail={t('workspaces.demo.detail')} handle={handleOf`page.workspaces.demo`}>
        <Stack direction="row">
          <Button
            handle={handleOf`page.workspaces.demo.load`}
            label={t('workspaces.demo')}
            icon="refresh"
            onpress={() => {
              void model.run('reference.preset.load', { preset: DEFAULT_CONFIG.preset });
            }}
          />
        </Stack>
      </Section>

      <Section title={t('workspaces.deleteAll')} detail={t('workspaces.deleteAll.detail')} handle={handleOf`page.workspaces.erase`}>
        {#if confirmingDelete}
          <Stack gap="small">
            <Text>{t('workspaces.deleteAll.confirm')}</Text>
            <Stack direction="row" gap="small">
              <Button
                handle={handleOf`page.workspaces.erase.confirm`}
                label={t('workspaces.deleteAll')}
                variant="danger"
                icon="delete"
                onpress={() => {
                  confirmingDelete = false;
                  void model.deleteAll();
                }}
              />
              <Button
                handle={handleOf`page.workspaces.erase.cancel`}
                label={t('replace.cancel')}
                onpress={() => {
                  confirmingDelete = false;
                }}
              />
            </Stack>
          </Stack>
        {:else}
          <Stack direction="row">
            <Button
              handle={handleOf`page.workspaces.erase.ask`}
              label={t('workspaces.deleteAll')}
              icon="delete"
              onpress={() => {
                confirmingDelete = true;
              }}
            />
          </Stack>
        {/if}
      </Section>
    {/if}
  </Stack>
</Panel>
