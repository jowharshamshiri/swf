import { afterEach, describe, expect, it } from 'vitest';
import { DOM_ATTRIBUTES } from '../../src/index.js';
import type { Stage } from './fixture.js';
import { stage } from './fixture.js';

let current: Stage | null = null;
afterEach(async () => {
  await current?.dispose();
  current = null;
  delete (window as { swfPwned?: unknown }).swfPwned;
});

const HOSTILE = '<img src="x" onerror="window.swfPwned = true"><b>bold</b>';

describe('labels and host metadata as text (SEC-010, QA-011)', () => {
  it('shows window and surface labels as the text they are, in titles and proxies', async () => {
    current = await stage(
      [{ id: 'a', heading: 0, distance: 3, label: HOSTILE, surfaceLabel: `${HOSTILE} view` }],
      { viewports: ['v', 'w'] },
    );
    const v = current.views.get('v');
    const w = current.views.get('w');
    const titles = [
      ...(v?.root.querySelectorAll(
        `[${DOM_ATTRIBUTES.layer}="chrome"] [${DOM_ATTRIBUTES.label}]`,
      ) ?? []),
    ];
    expect(titles.map((t) => t.textContent)).toEqual([HOSTILE]);
    const proxy = w?.root.querySelector(
      `[${DOM_ATTRIBUTES.layer}="proxy"] [${DOM_ATTRIBUTES.label}]`,
    );
    expect(proxy?.textContent).toBe(`${HOSTILE} view`);
    for (const root of [v?.root, w?.root]) {
      expect(root?.querySelector('img')).toBeNull();
      expect(root?.querySelector('b')).toBeNull();
    }
    // Give a parsed image the chance to fail and run its handler: nothing ran.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((window as { swfPwned?: unknown }).swfPwned).toBeUndefined();
  });

  it('labels an unbound surface’s placeholder as text too', async () => {
    current = await stage([{ id: 'a', heading: 0, distance: 3, label: HOSTILE }]);
    await current.runtime.unbind('a-view');
    const update = await current.views.get('v')?.update();
    const placeholder = current.views
      .get('v')
      ?.root.querySelector(`[${DOM_ATTRIBUTES.layer}="placeholder"]`);
    expect(update?.rendered.layers.find((l) => l.surfaceId === 'a-view')?.category).toBe(
      'placeholder',
    );
    expect(placeholder?.querySelector(`[${DOM_ATTRIBUTES.label}]`)?.textContent).toBe(HOSTILE);
    expect(placeholder?.querySelector('img')).toBeNull();
  });
});
