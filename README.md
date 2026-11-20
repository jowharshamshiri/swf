# Spatial Workspace Framework

A browser-first TypeScript framework for spatial presentation and window management. Applications
attach opaque presentation surfaces to entities in a 3D scene, arrange and manipulate them, and
show the same scene through several views. The framework owns spatial presentation state and
interaction; the host owns whatever is presented.

## Packages

- `@swf/math`: vectors, unit quaternions, position/rotation/scale transforms, affine matrices,
  rays and axis-aligned boxes. The world is right-handed and +Y up; the default camera looks along
  -Z with +X to the right. Lengths are arbitrary world units.
- `@swf/core`: the scene kernel. Spatial nodes and their hierarchy, constraints, atomic revisioned
  transactions, previews, undo and redo, idempotency keys, typed events and the workspace
  lifecycle. It needs no DOM, renderer or UI framework.

## Using the kernel

```ts
import { createWorkspace, worldMatrix } from '@swf/core';

const workspace = createWorkspace({ id: 'main' });

const result = workspace.transaction([
  {
    type: 'node.create',
    node: {
      id: 'notes',
      kind: 'window',
      bounds: [1.6, 0.9, 0.01],
      transform: { position: [0, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      label: 'Notes',
    },
  },
]);

if (result.status === 'rejected') {
  console.error(result.error.code, result.error.path, result.error.message);
}

workspace.subscribe((event) => {
  if (event.type === 'transaction.committed') {
    console.log('now at revision', event.revision);
  }
});

const world = worldMatrix(workspace.getState().nodes, 'notes');
```

A transaction applies all of its commands as one revision or none of them. A rejection carries an
error envelope with a stable `code` (such as `INVALID_INPUT`, `UNKNOWN_ENTITY`, `CONFLICT`,
`LOCKED` or `CONSTRAINT_REJECTED`), the `path` of the failing input and a readable message.
Committed state is immutable: every commit produces a new `SceneState`.

The commands are `node.create`, `node.patch`, `node.reparent`, `node.reorder`, `node.duplicate`,
`node.archive`, `node.restoreArchived`, `node.delete`, `node.group`, `node.ungroup`,
`selection.set` and `focus.set`. Each is documented on its type in `@swf/core`.

## Development

The workspace needs Node.js 24 or later and npm.

```sh
npm install     # install the locked development tools
npm run check   # formatting, type checks, lint, tests and build, in that order
npm test        # the test suites only
npm run build   # compile every package to dist/ (ES modules, declarations, source maps)
```

Tests run against each package's TypeScript source, so they need no build first.
