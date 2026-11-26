<script lang="ts">
  // WHAT CAN BE DONE WITH A WINDOW FOUND: focus it, centre the view on it, bring it in front of
  // the camera or send it behind, show it in the map, or inspect it. Only bringing and sending move
  // it (each one undoable change, at the distance it stands); each acts on the window's own ID,
  // whichever list or tile it was found in. Focus and the map are features: while one is off its
  // action says so. Where windows are listed, one can also be added to the selection or taken out,
  // as Ctrl+click does in the panorama.
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
    /** Offers to inspect it: not where it is being inspected already. */
    inspect?: boolean;
    /** Offers to add it to the selection, or take it out: where windows are listed. */
    toggle?: boolean;
  }

  let { model, id, handle, disabled = false, inspect = true, toggle = false }: Props = $props();
  const chosen = $derived(model.selection.includes(id));
  const t = (message: MessageId) => model.messages.format(message);
  const focusOn = $derived(model.policies?.features.enabled.focus ?? false);
  const mapOn = $derived(model.policies?.features.enabled.map ?? false);
</script>

<IconButton
  handle={keyed(`${handle}.focus`, id)}
  icon="pane-zoom"
  label={focusOn ? t('action.focus') : t('action.focus.off')}
  size="small"
  disabled={disabled || !focusOn}
  onpress={() => {
    void model.run('swf.focus.enter', { id });
  }}
/>
<IconButton
  handle={keyed(`${handle}.reveal`, id)}
  icon="show"
  label={t('action.reveal')}
  size="small"
  {disabled}
  onpress={() => {
    void model.run('swf.window.reveal', { id });
  }}
/>
<IconButton
  handle={keyed(`${handle}.front`, id)}
  icon="ahead"
  label={t('action.front')}
  size="small"
  {disabled}
  onpress={() => {
    void model.run('swf.window.bringFront', { id });
  }}
/>
<IconButton
  handle={keyed(`${handle}.behind`, id)}
  icon="behind"
  label={t('action.behind')}
  size="small"
  {disabled}
  onpress={() => {
    void model.run('swf.window.sendBehind', { id });
  }}
/>
<IconButton
  handle={keyed(`${handle}.map`, id)}
  icon="pin"
  label={mapOn ? t('action.map') : t('action.map.off')}
  size="small"
  disabled={disabled || !mapOn}
  onpress={() => {
    void model.showInMap(id);
  }}
/>
{#if toggle}
  <IconButton
    handle={keyed(`${handle}.select`, id)}
    icon="check"
    label={t('action.select')}
    size="small"
    pressed={chosen}
    {disabled}
    onpress={() => {
      void model.run('swf.selection.toggle', { id });
    }}
  />
{/if}
{#if inspect}
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
{/if}
