import '@wsb/uikit/styles/uikit.scss';
import '@wsb/uikit/fonts';
import { installAutomation } from '@wsb/uikit/automation';
import { ROOT_CLASS, setAppearance, setDensity } from '@wsb/uikit/primitives';
import { mount, unmount } from 'svelte';
import { ConfigError, parseConfig } from './config.js';
import { createMessages } from './messages.js';
import Shell from './shell/Shell.svelte';
import { developer } from 'virtual:reference/debug';
import { experiments } from 'virtual:reference/experiments';
import { ShellModel } from './shell/model.svelte.js';

/** What a replaced module hands the next: the disposal of the application it ran. */
interface HotData {
  disposing?: Promise<void>;
}

/** The configuration the address names, or why it names none the application can use. */
function configOf(search: string): ReturnType<typeof parseConfig> | ConfigError {
  try {
    return parseConfig(search);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
}

/** The page's element the application is mounted in. */
const MOUNT = 'app';

/**
 * Starts the application in the page: the kit's root class, appearance (the system's) and
 * density on the document, then the shell, which starts the workspace in its viewport. The shell
 * is mounted in the body's first element, which the kit lays out as the whole window.
 */
async function main(): Promise<void> {
  // In development an edit to the application or the framework replaces the running application
  // in place: the old one is disposed, leaving nothing behind, before the new one starts.
  const hot = import.meta.hot;
  const data = hot?.data as HotData | undefined;
  await data?.disposing;

  const target = document.getElementById(MOUNT);
  if (target === null) {
    throw new Error(`the page has no element with id "${MOUNT}" to mount the application in`);
  }
  if (target !== document.body.firstElementChild) {
    throw new Error(
      `the page's element "${MOUNT}" is not the body's first element, which the kit lays out as the window`,
    );
  }

  const html = document.documentElement;
  html.classList.add(ROOT_CLASS);
  setAppearance(html, null);
  setDensity(html, 'default');

  const model = new ShellModel(createMessages(), configOf(window.location.search));
  const shell = mount(Shell, { target, props: { model, developer, experiments } });
  // Automation presses what a person presses, by the kit's handles.
  installAutomation(document.body, () => 'reference');
  hot?.dispose((next: HotData) => {
    next.disposing = model.dispose().then(() => unmount(shell));
  });
}

import.meta.hot?.accept();
await main();
