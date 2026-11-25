import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { createResourceProbe } from '../../src/index.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
    heap: () => Promise<{ used: number; embedder: number | null } | null>;
  }
}

/**
 * Collects garbage where the browser lets automation ask for it (Chromium does; it reports its
 * heap only after collecting). False where it cannot be asked.
 */
async function collect(): Promise<boolean> {
  return (await commands.heap()) !== null;
}

describe('the resource probe keeps nothing alive', () => {
  it('lets an observer go once it is disconnected and dropped', async (context) => {
    const probe = createResourceProbe(window);
    const target = document.createElement('div');
    document.body.append(target);
    try {
      const observer = (() => {
        const made = new MutationObserver(() => undefined);
        made.observe(target, { attributes: true });
        made.disconnect();
        return new WeakRef(made);
      })();
      expect(probe.counts().observations).toBe(0);
      if (!(await collect())) {
        context.skip('this browser cannot be asked to collect garbage');
      }
      expect(observer.deref()).toBeUndefined();
    } finally {
      probe.dispose();
      target.remove();
    }
  });

  it('lets an observer go once what it observes is dropped, still counting what it observes while held', async (context) => {
    const probe = createResourceProbe(window);
    try {
      const observer = (() => {
        const target = document.createElement('div');
        document.body.append(target);
        const made = new MutationObserver(() => undefined);
        made.observe(target, { attributes: true });
        expect(probe.counts().observations).toBe(1);
        target.remove();
        expect(probe.counts().observations).toBe(0);
        return new WeakRef(made);
      })();
      if (!(await collect())) {
        context.skip('this browser cannot be asked to collect garbage');
      }
      expect(observer.deref()).toBeUndefined();
      expect(probe.counts().observations).toBe(0);
    } finally {
      probe.dispose();
    }
  });

  it('lets a listener go with the element it was added to', async (context) => {
    const probe = createResourceProbe(window);
    try {
      const listener = (() => {
        const element = document.createElement('div');
        document.body.append(element);
        const made = () => undefined;
        element.addEventListener('click', made);
        expect(probe.counts().listeners).toBe(1);
        element.remove();
        expect(probe.counts().listeners).toBe(0);
        return new WeakRef(made);
      })();
      if (!(await collect())) {
        context.skip('this browser cannot be asked to collect garbage');
      }
      expect(listener.deref()).toBeUndefined();
    } finally {
      probe.dispose();
    }
  });
});
