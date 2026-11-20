/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

/**
 * The packages each package may depend on. Nothing below the presentation contracts may reach a
 * concrete renderer or compositor: core geometry, persistence and interaction see only contracts.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  math: [],
  core: ['@swf/math'],
  surfaces: ['@swf/math', '@swf/core'],
  presentation: ['@swf/math', '@swf/core', '@swf/surfaces'],
  conformance: ['@swf/math', '@swf/core', '@swf/surfaces', '@swf/presentation'],
};

const sources = import.meta.glob<string>('../../*/src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const manifests = import.meta.glob<string>('../../*/package.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The package a globbed path belongs to; this package's own files come back as `../…`. */
function packageOf(path: string): string {
  const other = /^\.\.\/\.\.\/([^/]+)\//.exec(path)?.[1];
  if (other !== undefined) {
    return other;
  }
  if (path.startsWith('../')) {
    return 'presentation';
  }
  throw new Error(`cannot tell the package of ${path}`);
}

function imports(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier !== undefined && !specifier.startsWith('.')) {
      found.add(specifier);
    }
  }
  return [...found];
}

describe('package boundaries', () => {
  it('knows every package in the repository', () => {
    const packages = new Set(Object.keys(manifests).map(packageOf));
    expect([...packages].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('imports only the packages each package may depend on, and no concrete backend below presentation', () => {
    const violations: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      const pkg = packageOf(path);
      const allowed = ALLOWED[pkg] ?? [];
      for (const specifier of imports(source)) {
        if (!allowed.includes(specifier)) {
          violations.push(`${path} imports ${specifier}`);
        }
      }
    }
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    expect(violations).toEqual([]);
  });

  it('declares exactly the dependencies each package imports', () => {
    for (const [path, text] of Object.entries(manifests)) {
      const pkg = packageOf(path);
      const manifest = JSON.parse(text) as { dependencies?: Record<string, string> };
      const declared = Object.keys(manifest.dependencies ?? {}).sort();
      const used = new Set<string>();
      for (const [sourcePath, source] of Object.entries(sources)) {
        if (packageOf(sourcePath) === pkg) {
          imports(source).forEach((s) => used.add(s));
        }
      }
      // A package may declare a dependency it uses only for types it passes through.
      for (const specifier of used) {
        expect(declared, `${pkg} uses ${specifier}`).toContain(specifier);
      }
      for (const dependency of declared) {
        expect(ALLOWED[pkg], `${pkg} declares ${dependency}`).toContain(dependency);
      }
    }
  });
});
