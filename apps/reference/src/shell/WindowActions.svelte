<script lang="ts">
  // WHAT CAN BE DONE WITH A WINDOW FOUND: focus it, reveal it in the panorama, show it in the map,
  // or inspect it. None of them moves it; each acts on the window's own ID, whichever list or
  // tile it was found in.
  import { IconButton } from '@wsb/uikit/components';
  import { keyed } from '@wsb/uikit/handles';
  import type { MessageId } from '../messages.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
    id: string;
    /** The handle the actions are named under: `<handle>.focus#<id>`, and so on. */
    handle: string;
    disabled?: boolean;
  }

  let { model, id, handle, disabled = false }: Props = $props();
  const t = (message: MessageId) => model.messages.format(message);
</script>

<IconButton
  handle={keyed(`${handle}.focus`, id)}
  icon="pane-zoom"
  label={t('action.focus')}
  size="small"
  {disabled}
  onpress={() => {
    void model.run('reference.focus.enter', { id });
  }}
/>
<IconButton
  handle={keyed(`${handle}.reveal`, id)}
  icon="show"
  label={t('action.reveal')}
  size="small"
  {disabled}
  onpress={() => {
    void model.run('reference.window.reveal', { id });
  }}
/>
<IconButton
  handle={keyed(`${handle}.map`, id)}
  icon="pin"
  label={t('action.map')}
  size="small"
  {disabled}
  onpress={() => {
    void model.showInMap(id);
  }}
/>
<IconButton
  handle={keyed(`${handle}.inspect`, id)}
  icon="info"
  label={t('action.inspect')}
  size="small"
  {disabled}
  onpress={() => {
    void model.inspect(id);
  }}
/>
