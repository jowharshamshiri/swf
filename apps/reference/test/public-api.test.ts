/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

/**
 * The reference application is a host like any other (FR-185): it reaches the framework only
 * through each package's public entry point, by the package's bare name, and only the packages
 * it declares. Nothing reaches into a package's files, and nothing test-only ships in it.
 */

const sources = import.meta.glob<string>('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const manifest = import.meta.glob<string>('../package.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const packages = import.meta.glob<string>('../../../packages/*/package.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const viteConfig = import.meta.glob<string>('../vite.config.mjs', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function specifiers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(
    /(?:import|export)(?:[^'"]*?from)?\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g,
  )) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) {
      found.add(specifier);
    }
  }
  return [...found];
}

const declared = (): string[] => {
  const text = Object.values(manifest)[0];
  if (text === undefined) {
    throw new Error('no package.json for the application');
  }
  const json = JSON.parse(text) as { dependencies: Record<string, string> };
  return Object.keys(json.dependencies);
};

describe('the application uses only the public API (FR-185, ARCH-020)', () => {
  it('has sources to check', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it('imports framework packages by bare name only, and only those it declares', () => {
    const allowed = new Set(declared());
    const violations: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      for (const specifier of specifiers(source)) {
        if (specifier.startsWith('./')) {
          if (!/^\.\/[a-z-]+\.js$/.test(specifier)) {
            violations.push(`${path}: ${specifier} is not a sibling module`);
          }
        } else if (!allowed.has(specifier)) {
          violations.push(`${path}: ${specifier} is not a declared package`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('declares only framework packages besides its build tool, none of them test-only', () => {
    expect(declared().every((name) => name.startsWith('@swf/'))).toBe(true);
    expect(declared()).not.toContain('@swf/conformance');
  });

  it('depends on packages that expose a single public entry point', () => {
    const byName = new Map(
      Object.values(packages).map((text) => {
        const json = JSON.parse(text) as { name: string; exports: Record<string, unknown> };
        return [json.name, json] as const;
      }),
    );
    for (const name of declared()) {
      const pkg = byName.get(name);
      expect(pkg, name).toBeDefined();
      expect(Object.keys(pkg?.exports ?? {}), name).toEqual(['.']);
    }
  });

  it('builds against each package’s public entry point and nothing else', () => {
    const config = Object.values(viteConfig)[0] ?? '';
    expect(config).toContain('`../../packages/${pkg}/src/index.ts`');
    expect(config).not.toMatch(/packages\/[a-z-]+\/src\/(?!index\.ts)/);
  });
});
