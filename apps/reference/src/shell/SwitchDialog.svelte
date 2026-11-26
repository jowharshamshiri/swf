<script lang="ts">
  // ASKED WHEN A SWITCH COULD NOT SAVE THE SPACE SHOWN FIRST: why it was not saved, and whether to
  // switch anyway, giving up its unsaved changes, or to stay. Escape stays, as VS Code's Cancel
  // does when it cannot save before it closes a workspace.
  import { Button, Dialog, Text } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import type { MessageId } from '../messages.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
    /** The space asked for, and why the space shown could not be saved. */
    asking: { readonly name: string; readonly error: { readonly message: string } };
  }

  let { model, asking }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);
  const space = $derived(model.workspaces?.space ?? '');
</script>

<Dialog
  title={t('switch.title')}
  handle={handleOf`page.switch`}
  onclose={() => {
    void model.answerSwitch(false);
  }}
>
  <Text>{t('switch.body', { space, name: asking.name, reason: asking.error.message })}</Text>
  {#snippet actions()}
    <Button
      handle={handleOf`page.switch.stay`}
      label={t('switch.stay')}
      variant="primary"
      onpress={() => {
        void model.answerSwitch(false);
      }}
    />
    <Button
      handle={handleOf`page.switch.discard`}
      label={t('switch.discard')}
      variant="danger"
      onpress={() => {
        void model.answerSwitch(true);
      }}
    />
  {/snippet}
</Dialog>
