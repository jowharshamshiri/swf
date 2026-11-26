import '@wsb/uikit/styles/uikit.scss';
import '@wsb/uikit/fonts';
import { installAutomation } from '@wsb/uikit/automation';
import { ROOT_CLASS, setAppearance, setDensity } from '@wsb/uikit/primitives';
import { mount } from 'svelte';
import Host from './Host.svelte';
import { Host as HostState } from './host.svelte.js';

/**
 * Starts the host page: the kit's root class, appearance and density on the document, then the
 * host's window, which makes the framework's navigation over the host's own content once the
 * panorama has its surface. The page is mounted in the body's first element, which the kit lays
 * out as the whole window.
 */
const target = document.getElementById('app');
if (target === null || target !== document.body.firstElementChild) {
  throw new Error('the page needs an element "app" as the body’s first element to mount in');
}
const html = document.documentElement;
html.classList.add(ROOT_CLASS);
setAppearance(html, null);
setDensity(html, 'default');
const host = new HostState(document);
mount(Host, { target, props: { host } });
installAutomation(document.body, () => 'host');
// The page says when its navigation is up, for whatever drives it.
await host.started();
html.dataset['swfExample'] = host.problem === null ? 'ready' : 'failed';
