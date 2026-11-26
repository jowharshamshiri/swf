<script lang="ts">
  // THE HOST'S OWN VIEW CONTROLS, in place of the package's: the same model and the same commands,
  // laid out the host's way, two sliders, which way the view faces and how wide it looks.
  import { Slider, Stack, Toolbar } from '@wsb/uikit/components';
  import { handleOf } from '@wsb/uikit/handles';
  import { cameraHeading, FIELD_OF_VIEW, fieldOfViewOf, VIEWPORT_ID } from '@swf/navigation';
  import type { NavigationModel } from '@swf/navigation-ui';
  import type { HostMessageId } from './messages.js';

  interface Props {
    model: NavigationModel;
    t: (id: HostMessageId) => string;
  }

  let { model, t }: Props = $props();

  const view = $derived.by(() => {
    void model.revision;
    const navigation = model.navigation;
    const state = navigation?.workspace.getState();
    const record = state?.viewports.get(VIEWPORT_ID);
    if (navigation === null || state === undefined || record === undefined) {
      return null;
    }
    return {
      heading: (cameraHeading(state, VIEWPORT_ID) * 180) / Math.PI,
      fov: fieldOfViewOf(navigation.modes.panorama()),
    };
  });
</script>

{#if view !== null}
  <Toolbar ariaLabel={t('host.own.label')}>
    <Stack direction="row" gap="large" grow>
      <Stack grow>
        <Slider
          handle={handleOf`page.host-view.heading`}
          label={t('host.own.heading')}
          value={view.heading}
          min={-180}
          max={180}
          unit="°"
          oninput={(degrees) => {
            void model.runNavigation('swf.view.heading', { degrees });
          }}
        />
      </Stack>
      <Stack grow>
        <Slider
          handle={handleOf`page.host-view.fov`}
          label={t('host.own.fov')}
          value={Math.min(FIELD_OF_VIEW.max, Math.max(FIELD_OF_VIEW.min, view.fov))}
          min={FIELD_OF_VIEW.min}
          max={FIELD_OF_VIEW.max}
          unit="°"
          oninput={(degrees) => {
            void model.runNavigation('swf.view.fov', { degrees });
          }}
        />
      </Stack>
    </Stack>
  </Toolbar>
{/if}
