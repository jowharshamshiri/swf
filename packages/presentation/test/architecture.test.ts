/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

/**
 * The packages each package may depend on. Nothing below the presentation contracts may reach a
 * concrete renderer or compositor: core geometry, persistence and interaction see only contracts.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  math: [],
  // The state machines and decision logic, compiled from Lean, on lungo's WebAssembly host.
  models: ['lungo-ts'],
  core: ['@swf/math', '@swf/models'],
  surfaces: ['@swf/math', '@swf/core', '@swf/models'],
  presentation: ['@swf/math', '@swf/core', '@swf/surfaces', '@swf/models'],
  projections: ['@swf/math', '@swf/core', '@swf/presentation'],
  interaction: ['@swf/math', '@swf/core', '@swf/presentation', '@swf/projections', '@swf/models'],
  'backend-dom': [
    '@swf/math',
    '@swf/core',
    '@swf/surfaces',
    '@swf/presentation',
    '@swf/projections',
    '@swf/interaction',
  ],
  'backend-geometry': [
    '@swf/math',
    '@swf/core',
    '@swf/surfaces',
    '@swf/presentation',
    '@swf/projections',
  ],
  conformance: ['@swf/math', '@swf/core', '@swf/surfaces', '@swf/presentation'],
  diagnostics: ['@swf/core', '@swf/surfaces', '@swf/presentation'],
  persistence: ['@swf/math', '@swf/core', '@swf/models'],
  // The benchmark presents its fixtures as a host would, with the DOM backend.
  benchmark: [
    '@swf/math',
    '@swf/core',
    '@swf/surfaces',
    '@swf/presentation',
    '@swf/projections',
    '@swf/interaction',
    '@swf/backend-dom',
  ],
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

/** The packages a source imports, by name: a subpath (`lungo-ts/wasi.js`) is its package. */
function imports(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier !== undefined && !specifier.startsWith('.')) {
      found.add(packageName(specifier));
    }
  }
  return [...found];
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
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
