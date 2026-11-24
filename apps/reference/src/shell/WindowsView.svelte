<script lang="ts">
  // EVERY WINDOW, as a list: the panorama's windows by name, the selected one marked. Pressing
  // one selects it and turns the camera to it, so any window is reached without a pointer on it.
  import { List, ListItem, Pane } from '@wsb/uikit/components';
  import { handleOf, keyed } from '@wsb/uikit/handles';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
  }

  let { model }: Props = $props();
  const t = (id: Parameters<typeof model.messages.format>[0]) => model.messages.format(id);

  // Read again whenever the scene's status changes: windows come and go with it.
  const windows = $derived.by(() => {
    void model.status;
    return model.windows();
  });
</script>

<Pane
  title={t('windows.title')}
  handle={handleOf`page.windows`}
  empty={windows.length === 0 ? { icon: 'list', title: t('empty.title') } : null}
>
  <List ariaLabel={t('windows.title')}>
    {#each windows as window (window.id)}
      <ListItem
        handle={keyed('page.windows.window', window.id)}
        title={window.label}
        detail={window.id}
        icon="document"
        selected={model.selected?.id === window.id}
        onpress={() => {
          void model.run('reference.window.reveal', { id: window.id });
        }}
      />
    {/each}
  </List>
</Pane>
