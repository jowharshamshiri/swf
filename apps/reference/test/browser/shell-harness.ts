import '@wsb/uikit/styles/uikit.scss';
import '@wsb/uikit/fonts';
import { installAutomation } from '@wsb/uikit/automation';
import type { SurfaceAutomation } from '@wsb/uikit/automation';
import { ROOT_CLASS, setAppearance, setDensity } from '@wsb/uikit/primitives';
import { mount, unmount } from 'svelte';
import { surfaceWorldMatrix, worldMatrix } from '@swf/core';
import { mat4ApproxEquals } from '@swf/math';
import { afterEach, expect } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { createMessages } from '../../src/messages.js';
import type { ShellAppOptions } from '../../src/shell/model.svelte.js';
import { ShellModel } from '../../src/shell/model.svelte.js';
import DeveloperView from '../../src/shell/DeveloperView.svelte';
import Shell from '../../src/shell/Shell.svelte';

/**
 * The shell as the page mounts it, with the developer panel and a store of the test's own, for
 * suites that drive the whole application: each test's shells are taken down after it.
 */

export interface Mounted {
  readonly model: ShellModel;
  readonly root: HTMLElement;
  readonly driver: SurfaceAutomation;
  readonly settle: () => Promise<void>;
}

const mounted: { model: ShellModel; shell: ReturnType<typeof mount>; root: HTMLElement }[] = [];

/**
 * Ends every visit mounted: a page holds one application at a time, with its one announcer, so
 * the next visit starts once the last has ended, as a reload does.
 */
export async function endVisits(): Promise<void> {
  for (const m of mounted.splice(0)) {
    await m.model.dispose();
    await unmount(m.shell);
    m.root.remove();
  }
}

afterEach(endVisits);

/**
 * Mounts the shell as the page does, with the developer panel and a store of the test's own, in a
 * page of a size (by default 1280 × 760).
 */
export async function start(
  search: string,
  appOptions: ShellAppOptions,
  size: { readonly width: number; readonly height: number } = { width: 1280, height: 760 },
): Promise<Mounted> {
  const html = document.documentElement;
  html.classList.add(ROOT_CLASS);
  setAppearance(html, 'light');
  setDensity(html, 'default');
  const root = document.createElement('div');
  root.style.setProperty('position', 'absolute');
  root.style.setProperty('inset', '0 auto auto 0');
  root.style.setProperty('width', `${String(size.width)}px`);
  root.style.setProperty('height', `${String(size.height)}px`);
  document.body.append(root);
  const model = new ShellModel(createMessages(), parseConfig(search), appOptions);
  const shell = mount(Shell, { target: root, props: { model, developer: DeveloperView } });
  mounted.push({ model, shell, root });
  const driver = installAutomation(root, () => 'reference');
  const settle = async () => {
    await driver.settled();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await driver.settled();
  };
  await expect.poll(() => model.status, { timeout: 10_000 }).not.toBeNull();
  await settle();
  return { model, root, driver, settle };
}

export const same = (a: Float64Array | readonly number[] | undefined, b: typeof a) =>
  a !== undefined && b !== undefined && mat4ApproxEquals(a as never, b as never, 1e-9);

/** Every node's parent and world matrix, and every surface's owner and world matrix. */
export function layout(model: ShellModel) {
  const state = model.app?.workspace.getState();
  if (state === undefined) {
    throw new Error('no application');
  }
  return {
    nodes: [...state.nodes.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((n) => ({
        id: n.id,
        parentId: n.parentId,
        world: worldMatrix(state.nodes, n.id),
      })),
    surfaces: [...state.surfaces.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((s) => ({
        id: s.id,
        owner: s.ownerNodeId,
        world: surfaceWorldMatrix(state, s.id),
      })),
  };
}
