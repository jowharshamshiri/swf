/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

// Every package's source, as text.
const sources = import.meta.glob<string>('../../*/src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Ways of turning text into markup or code. None of them may appear in the framework. */
const FORBIDDEN: readonly [string, RegExp][] = [
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\.write(?:ln)?\s*\(/],
  ['createContextualFragment', /\bcreateContextualFragment\b/],
  ['DOMParser', /\bDOMParser\b/],
  ['srcdoc', /\bsrcdoc\b/],
  ['eval', /(?<![.\w])eval\s*\(/],
  ['Function constructor', /\bnew\s+Function\s*\(/],
  ['setAttribute of an event handler', /setAttribute\(\s*['"]on/i],
];

describe('labels and host data as text (SEC-010, QA-011)', () => {
  it('never parse markup or evaluate code anywhere in the framework', () => {
    const files = Object.entries(sources);
    expect(files.length).toBeGreaterThan(40);
    const found = files.flatMap(([path, text]) =>
      FORBIDDEN.flatMap(([name, pattern]) => (pattern.test(text) ? [`${path}: ${name}`] : [])),
    );
    expect(found).toEqual([]);
  });

  it('catch each forbidden form when it does appear', () => {
    const samples = [
      'el.innerHTML = x',
      'el.outerHTML',
      'el.insertAdjacentHTML("beforeend", x)',
      'document.write(x)',
      'range.createContextualFragment(x)',
      'new DOMParser()',
      'frame.srcdoc = x',
      'eval(code)',
      'new Function("return 1")',
      "el.setAttribute('onclick', x)",
    ];
    samples.forEach((sample, i) => {
      expect(FORBIDDEN[i]?.[1].test(sample)).toBe(true);
    });
    expect(FORBIDDEN.some(([, pattern]) => pattern.test('label.textContent = text'))).toBe(false);
  });
});
