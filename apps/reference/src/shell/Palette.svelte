<script lang="ts">
  // COMMAND AND SEARCH: every command of the application, and every window by its name, picked
  // by typing a few letters. Picking a window selects it and turns the camera to it.
  import { QuickPick } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import type { AppCommandId, AppCommandSpecs } from '../commands.js';
  import { BACKEND_IDS } from '../config.js';
  import { FEATURE_IDS } from '../features.js';
  import { FOCUS_ID } from '../focus.js';
  import type { MessageId } from '../messages.js';
  import { PRESET_IDS, PRESETS } from '../presets.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
    onclose: () => void;
  }

  let { model, onclose }: Props = $props();
  const t = (id: MessageId, params?: Readonly<Record<string, string | number>>) =>
    model.messages.format(id, params);

  let query = $state('');

  /** One pick: what it says, and the command it runs. */
  interface Entry {
    readonly value: string;
    readonly label: string;
    readonly detail: string;
    readonly run: () => Promise<boolean>;
  }

  const command = <K extends AppCommandId>(
    value: string,
    label: string,
    id: K,
    params: AppCommandSpecs[K],
  ): Entry => ({
    value,
    label,
    detail: t('palette.command'),
    run: () => model.run(id, params),
  });

  const entries = $derived.by((): Entry[] => [
    command('scene.reset', t('command.scene.reset'), 'reference.scene.reset', {}),
    command('scene.reseed', t('command.scene.reseed'), 'reference.scene.reseed', {}),
    ...PRESET_IDS.map((preset) =>
      command(
        `preset.${preset}`,
        t('command.preset.load.named', { preset: t(PRESETS[preset].name) }),
        'reference.preset.load',
        { preset },
      ),
    ),
    ...(model.app?.modes.list() ?? []).map((mode) =>
      command(
        `mode.${mode.id}`,
        t('command.mode.switch.named', { mode: t(mode.name) }),
        'reference.mode.switch',
        { mode: mode.id },
      ),
    ),
    ...(model.selected === null || model.policies?.features.enabled.focus !== true
      ? []
      : [
          command(
            'focus.enter',
            t('command.focus.enter.named', { label: model.selected.label ?? model.selected.id }),
            'reference.focus.enter',
            { id: model.selected.id },
          ),
        ]),
    ...(model.selected === null
      ? []
      : [
          {
            value: 'window.remove',
            label: t('command.window.remove.named', {
              label: model.selected.label ?? model.selected.id,
            }),
            detail: t('palette.command'),
            run: () => (model.selected === null ? Promise.resolve(false) : model.removeWindow(model.selected.id)),
          },
        ]),
    ...(model.policies?.features.enabled.persistence === true
      ? [command('workspace.export', t('command.workspace.export'), 'reference.workspace.export', {})]
      : []),
    ...(model.status?.mode === FOCUS_ID
      ? [
          command('focus.exit', t('command.focus.exit'), 'reference.focus.exit', {}),
          command('focus.left', t('command.focus.step.left'), 'reference.focus.step', {
            direction: 'left',
          }),
          command('focus.right', t('command.focus.step.right'), 'reference.focus.step', {
            direction: 'right',
          }),
        ]
      : []),
    ...(model.history.undo
      ? [command('history.undo', t('command.history.undo'), 'reference.history.undo', {})]
      : []),
    ...(model.history.redo
      ? [command('history.redo', t('command.history.redo'), 'reference.history.redo', {})]
      : []),
    ...FEATURE_IDS.map((feature) => {
      const on = model.policies?.features.enabled[feature] ?? false;
      return command(
        `feature.${feature}`,
        t(on ? 'command.feature.set.off' : 'command.feature.set.on', {
          feature: t(`feature.${feature}`),
        }),
        'reference.feature.set',
        { feature, enabled: !on },
      );
    }),
    command('feature.combine', t('command.feature.combine'), 'reference.feature.combine', {}),
    command('feature.reset', t('command.feature.reset'), 'reference.feature.reset', {}),
    ...(model.policies?.features.enabled.orbit === true
      ? [
          command('navigation.camera', t('command.navigation.camera'), 'reference.navigation.set', {
            target: 'camera',
          }),
          ...(model.policies.orbit.rootId === null
            ? []
            : [
                command('navigation.orbit', t('command.navigation.orbit'), 'reference.navigation.set', {
                  target: 'orbit',
                }),
                command('orbit.left', t('command.orbit.turn.left'), 'reference.orbit.turn', {
                  degrees: -15,
                }),
                command('orbit.right', t('command.orbit.turn.right'), 'reference.orbit.turn', {
                  degrees: 15,
                }),
              ]),
        ]
      : []),
    ...BACKEND_IDS.map((backend) =>
      command(
        `backend.${backend}`,
        t('command.backend.switch.named', { backend: t(`backend.${backend}`) }),
        'reference.backend.switch',
        { backend },
      ),
    ),
    ...model.windows().map((window) => ({
      value: `window.${window.id}`,
      label: t('command.window.reveal.named', { label: window.label }),
      detail: t('palette.window'),
      run: () => model.run('reference.window.reveal', { id: window.id }),
    })),
  ]);

  const shown = $derived.by(() => {
    const words = query.toLocaleLowerCase().split(/\s+/).filter((w) => w !== '');
    return entries.filter((entry) => {
      const text = entry.label.toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    });
  });
</script>

<QuickPick
  handle={handleOf`application.palette`}
  ariaLabel={t('palette.label')}
  placeholder={t('palette.placeholder')}
  {query}
  oninput={(next) => {
    query = next;
  }}
  prefix={{ text: '>' }}
  items={shown.map(({ value, label, detail }) => ({ value, label, detail }))}
  emptyText={t('palette.empty')}
  onselect={(value) => {
    const entry = entries.find((e) => e.value === value);
    onclose();
    void entry?.run();
  }}
  {onclose}
/>
