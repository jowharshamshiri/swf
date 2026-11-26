<script lang="ts">
  // COMMAND AND SEARCH: every command of the application, and every window by its name, picked
  // by typing a few letters. Picking a window selects it and turns the camera to it.
  import { QuickPick } from '@wsb/uikit/components';
  import { tick } from 'svelte';
  import { handleOf } from '@wsb/uikit/handles';
  import type { AppCommandId, AppCommandSpecs } from '../commands.js';
  import { BACKEND_IDS } from '../config.js';
  import { CAPABILITY_ORDER, EXPERIMENT_IDS, EXPERIMENTS } from '../experiments.js';
  import { FOCUS_ID } from '../focus.js';
  import type { MessageId } from '../messages.js';
  import { PRESET_IDS, PRESETS } from '../presets.js';
  import { SCENARIO_IDS, SCENARIOS } from '../scenarios.js';
  import { METHOD_IDS, METHOD_NAMES } from '../challenge.js';
  import type { ShellModel } from './model.svelte.js';

  interface Props {
    model: ShellModel;
    /** Whether the build carries the experiment panel: its commands are offered with it. */
    experimental: boolean;
    onclose: () => void;
  }

  let { model, experimental, onclose }: Props = $props();
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
            label:
              model.selection.length > 1
                ? t('command.window.remove.many', { count: model.selection.length })
                : t('command.window.remove.named', { label: model.selected.label ?? model.selected.id }),
            detail: t('palette.command'),
            run: () => (model.selected === null ? Promise.resolve(false) : model.removeWindows(model.selection)),
          },
        ]),
    ...(model.selected === null
      ? []
      : [
          command(
            'window.lock',
            t(model.selected.locked ? 'command.window.unlock.named' : 'command.window.lock.named', {
              label: model.selected.label ?? model.selected.id,
            }),
            'reference.window.lock',
            { id: model.selected.id, locked: !model.selected.locked },
          ),
          command(
            'gesture.grab',
            t('command.gesture.grab.named', { label: model.selected.label ?? model.selected.id }),
            'reference.gesture.grab',
            { id: model.selected.id },
          ),
          command(
            'window.bringFront',
            t('command.window.bringFront.named', { label: model.selected.label ?? model.selected.id }),
            'reference.window.bringFront',
            { id: model.selected.id },
          ),
          command(
            'window.sendBehind',
            t('command.window.sendBehind.named', { label: model.selected.label ?? model.selected.id }),
            'reference.window.sendBehind',
            { id: model.selected.id },
          ),
        ]),
    command('window.add', t('command.window.add'), 'reference.window.add', {}),
    {
      value: 'panorama.focus',
      label: t('command.panorama.focus'),
      detail: t('palette.command'),
      run: () => Promise.resolve(model.focusPanorama()),
    },
    ...(model.policies?.features.enabled.persistence === true
      ? [
          command('workspace.saveNow', t('command.workspace.saveNow'), 'reference.workspace.saveNow', {}),
          command('workspace.export', t('command.workspace.export'), 'reference.workspace.export', {}),
        ]
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
    // The experimental interface, where the build carries the experiment panel.
    ...(experimental
      ? [
          ...EXPERIMENT_IDS.map((experiment) =>
            command(
              `experiment.${experiment}`,
              t('command.experiment.run.named', {
                number: EXPERIMENTS[experiment].number,
                name: t(EXPERIMENTS[experiment].name),
              }),
              'reference.experiment.run',
              { experiment },
            ),
          ),
          ...CAPABILITY_ORDER.map((feature) => {
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
          command('feature.reset', t('command.feature.reset'), 'reference.feature.reset', {}),
        ]
      : []),
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
    ...SCENARIO_IDS.map((scenario) =>
      command(
        `scenario.${scenario}`,
        t('command.scenario.start.named', { scenario: t(SCENARIOS[scenario].name) }),
        'reference.scenario.start',
        { scenario },
      ),
    ),
    ...(model.scenario === null
      ? []
      : [command('scenario.stop', t('command.scenario.stop'), 'reference.scenario.stop', {})]),
    ...METHOD_IDS.map((method) =>
      command(
        `challenge.${method}`,
        t('command.challenge.start.named', { method: t(METHOD_NAMES[method]) }),
        'reference.challenge.start',
        { method },
      ),
    ),
    ...(model.challenge?.run == null
      ? []
      : [command('challenge.cancel', t('command.challenge.cancel'), 'reference.challenge.cancel', {})]),
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
    // It runs once the list is gone and has given the keyboard back, so what it does with the
    // keyboard (going to the panorama) stands.
    void tick().then(() => entry?.run());
  }}
  {onclose}
/>
