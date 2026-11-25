# 0008. ES module packages compiled without a bundler, tree-shakeable and size-budgeted

- **Status:** Accepted
- **Date:** 2026-11-20 (size budgets 2026-11-25)
- **Requirements:** FR-180, FR-183, NFR-015, ENV-002, ENV-004, ENV-008

## Context

Hosts load the framework through their own bundlers or straight from the browser's module loader,
and pay for whatever code they ship. Optional modules must cost nothing when unused, and modules
are loaded at run time by the host, not by a plugin runtime.

## Decision

The packages are npm workspaces of TypeScript compiled by `tsc` (NodeNext resolution, `.js`
specifiers) to ES2022 modules with declarations and source maps: no bundler builds them. Each has
one entry point and declares `sideEffects: false`, except `@swf/models`, which declares the module
that loads its program. `npm run size` bundles every package as a browser application would and
fails one that leaves code behind when imported for nothing, or that exceeds its gzip budget in
`size-budgets.json`; it reports each package's change from its recorded size. A browser example
loads the built packages through an import map alone.

## Alternatives

- **One bundled package.** Every host would ship every backend and module.
- **Pre-bundled packages per module.** Duplicates shared code between bundles and hides the
  import graph the architecture test checks.
- **A plugin loader of its own.** The platform's `import()` already loads modules under the host's
  control and Content Security Policy.

## Consequences

Budgets start 10% above each package's size when they were set; raising one is a deliberate
change to `size-budgets.json`, reviewed with the change that needs it.

## Migration impact

Moving to a bundled build would change how hosts import the packages; the entry points would have
to stay the same names.
