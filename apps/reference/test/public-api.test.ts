/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

/**
 * The reference application is a host like any other (FR-185): it reaches the framework only
 * through each package's public entry point, by the package's bare name, and only the packages
 * it declares. Nothing reaches into a package's files, and nothing test-only ships in it. Its UI
 * framework and kit are its own: no framework package learns of either (ARCH-020, FR-182).
 */

const sources = import.meta.glob<string>(['../src/**/*.ts', '../src/**/*.svelte'], {
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
const packageSources = import.meta.glob<string>('../../../packages/*/src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const uiSources = import.meta.glob<string>(
  ['../../../ui/navigation/src/**/*.ts', '../../../ui/navigation/src/**/*.svelte'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);
const uiManifest = import.meta.glob<string>('../../../ui/navigation/package.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const kitManifest = import.meta.glob<string>('../../../wsb/wsb/daemon/uikit/package.json', {
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
    // A statement starting a line, so a word inside a string (`'reference.workspace.import'`) is not one.
    /^\s*(?:import|export)\b(?:[^'"]*?from)?\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm,
  )) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) {
      found.add(specifier);
    }
  }
  return [...found];
}

const only = (globbed: Record<string, string>, what: string): string => {
  const text = Object.values(globbed)[0];
  if (text === undefined) {
    throw new Error(`no ${what}`);
  }
  return text;
};

const declared = (): Record<string, string> =>
  (
    JSON.parse(only(manifest, "the application's package.json")) as {
      dependencies: Record<string, string>;
    }
  ).dependencies;

/** The kit's public entry points, as its package exports them. */
const kitExports = (): string[] =>
  Object.keys(
    (JSON.parse(only(kitManifest, "the kit's package.json")) as { exports: Record<string, string> })
      .exports,
  ).map((path) => `@wsb/uikit${path.slice(1)}`);

describe('the application uses only the public API (FR-185, ARCH-020)', () => {
  it('has sources to check, Svelte components among them', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(Object.keys(sources).some((path) => path.endsWith('.svelte'))).toBe(true);
  });

  it('imports framework packages and the kit by their public entry points, and only what it declares', () => {
    const framework = new Set(Object.keys(declared()).filter((name) => name.startsWith('@swf/')));
    const kit = new Set(kitExports());
    const violations: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      for (const specifier of specifiers(source)) {
        const fine =
          /^\.\.?\/(?:[a-z-]+\/)?(?:[a-z-]+(?:\.svelte)?\.js|[A-Z][A-Za-z]+\.svelte)$/.test(
            specifier,
          ) ||
          framework.has(specifier) ||
          kit.has(specifier) ||
          specifier === 'svelte' ||
          // The build's own modules saying which optional views it carries: the debug overlay and
          // the experiment panel.
          specifier === 'virtual:reference/debug' ||
          specifier === 'virtual:reference/experiments';
        if (!fine) {
          violations.push(`${path}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('declares the framework, and the kit at the folder the pinned checkout of wsb holds', () => {
    const dependencies = declared();
    expect(dependencies['@wsb/uikit']).toBe('file:../../wsb/wsb/daemon/uikit');
    expect(Object.keys(dependencies)).not.toContain('@swf/conformance');
  });

  it('depends on framework packages, and the navigation controls, whose one code entry point is their index', () => {
    const byName = new Map(
      [...Object.values(packages), ...Object.values(uiManifest)].map((text) => {
        const json = JSON.parse(text) as { name: string; exports: Record<string, unknown> };
        return [json.name, json] as const;
      }),
    );
    for (const name of Object.keys(declared()).filter((n) => n.startsWith('@swf/'))) {
      const pkg = byName.get(name);
      expect(pkg, name).toBeDefined();
      // Besides it a package may publish data, such as a JSON Schema, but no other code.
      const exported = Object.keys(pkg?.exports ?? {});
      expect(exported, name).toContain('.');
      expect(
        exported.filter((path) => path !== '.' && !path.endsWith('.json')),
        name,
      ).toEqual([]);
    }
  });

  it('leaves every framework package free of the UI framework, the kit and wsb', () => {
    expect(Object.keys(packageSources).length).toBeGreaterThan(20);
    const violations: string[] = [];
    for (const [path, source] of Object.entries(packageSources)) {
      for (const specifier of specifiers(source)) {
        if (/^(?:svelte|@sveltejs\/|@wsb\/|lucide)/.test(specifier) || specifier.includes('wsb')) {
          violations.push(`${path}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
    for (const text of Object.values(packages)) {
      const json = JSON.parse(text) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const all = Object.keys({
        ...json.dependencies,
        ...json.devDependencies,
        ...json.peerDependencies,
      });
      // The models run on lungo's WebAssembly host, the one dependency outside the framework.
      expect(
        all.filter(
          (name) =>
            !name.startsWith('@swf/') && !(json.name === '@swf/models' && name === 'lungo-ts'),
        ),
        json.name,
      ).toEqual([]);
    }
  });

  it('builds against each framework package’s public entry point and nothing else', () => {
    const config = only(viteConfig, "the application's Vite configuration");
    expect(config).toContain('`../../packages/${pkg}/src/index.ts`');
    expect(config).not.toMatch(/packages\/[a-z-]+\/src\/(?!index\.ts)/);
  });
});

describe('the navigation controls use only the public API', () => {
  const manifest = JSON.parse(only(uiManifest, "the navigation controls' package.json")) as {
    dependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
  };

  it('has sources to check, Svelte components among them', () => {
    expect(Object.keys(uiSources).length).toBeGreaterThan(10);
    expect(Object.keys(uiSources).some((path) => path.endsWith('.svelte'))).toBe(true);
  });

  it('imports framework packages and the kit by their public entry points, its own files, and only what it declares', () => {
    const framework = new Set(
      Object.keys(manifest.dependencies).filter((name) => name.startsWith('@swf/')),
    );
    const kit = new Set(kitExports());
    const violations: string[] = [];
    for (const [path, source] of Object.entries(uiSources)) {
      for (const specifier of specifiers(source)) {
        const fine =
          /^\.\/(?:[a-z-]+(?:\.svelte)?\.js|[A-Z][A-Za-z]+\.svelte)$/.test(specifier) ||
          framework.has(specifier) ||
          kit.has(specifier) ||
          specifier === 'svelte';
        if (!fine) {
          violations.push(`${path}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('depends on the framework by its packages, the kit by its pinned checkout, and Svelte as its host’s', () => {
    expect(manifest.dependencies['@wsb/uikit']).toBe('file:../../wsb/wsb/daemon/uikit');
    expect(Object.keys(manifest.peerDependencies)).toEqual(['svelte']);
    const outside = Object.keys(manifest.dependencies).filter(
      (name) => !name.startsWith('@swf/') && name !== '@wsb/uikit',
    );
    expect(outside).toEqual([]);
  });
});
