# Spatial Workspace Framework

A browser-first TypeScript framework for spatial presentation and window management. Applications
attach opaque presentation surfaces to entities in a 3D scene, arrange and manipulate them, and
show the same scene through several views. The framework owns spatial presentation state and
interaction; the host owns whatever is presented.

## Packages

- `@swf/math`: vectors, unit quaternions, position/rotation/scale transforms, affine matrices,
  rays and axis-aligned boxes. The world is right-handed and +Y up; the default camera looks along
  -Z with +X to the right. Lengths are arbitrary world units.
- `@swf/core`: the scene kernel. Spatial nodes and their hierarchy, surface associations with
  their geometry, constraints, atomic revisioned transactions, previews, undo and redo,
  idempotency keys, typed events and the workspace lifecycle. It needs no DOM, renderer or UI
  framework.
- `@swf/surfaces`: binds the scene's surface associations to the host's presentation endpoints
  through registered adapters, negotiates each endpoint's capabilities, and drives every surface
  through its presentation lifecycle. It never inspects, decodes or runs what an endpoint shows,
  and releasing a surface never stops the endpoint's producer.

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
  {
    type: 'surface.attach',
    surface: {
      id: 'notes-view',
      ownerNodeId: 'notes',
      bindingKey: 'editor-42',
      adapterTypeId: 'host.editor/1',
      bounds: [1.6, 0.9, 0.01],
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

The node commands are `node.create`, `node.patch`, `node.reparent`, `node.reorder`,
`node.duplicate`, `node.archive`, `node.restoreArchived`, `node.delete`, `node.group`,
`node.ungroup`, `selection.set` and `focus.set`. The surface commands are `surface.attach`,
`surface.patch`, `surface.move`, `surface.reorder`, `surface.rebind` and `surface.detach`. Each
is documented on its type in `@swf/core`.

A surface's geometry is a descriptor: the built-in `rect` and `polygon`, or a kind the host
registers with `registerGeometry`. Descriptors are validated against configurable complexity
limits, and `workspace.surfaceGeometry(id)` places one in the world for rendering and picking.

## Binding surfaces

```ts
import { createSurfaceRuntime } from '@swf/surfaces';

const surfaces = createSurfaceRuntime(workspace, { bindingTimeoutMs: 15_000 });

surfaces.registerAdapter({
  id: 'host.editor/1',
  apiVersion: 1,
  declaredCapabilities: {
    attachStrategy: 'native-dom',
    nativeInteraction: 'full',
    uvAddressing: true,
    transformFidelity: 'approximate',
    transparency: true,
    clipping: true,
    cursorMapping: true,
    resize: 'spatial',
    viewportSharing: 'single-owner',
    safeDetach: true,
    rebinding: true,
    placeholder: false,
    snapshotHooks: false,
  },
  resolve: (bindingKey, signal) => editors.find(bindingKey, signal), // null for an unknown key
  capabilities: (editor) => editor.capabilities,
  attach: (editor, target) => editor.mountInto(target.container),
  update: (editor, hint) => editor.considerHint(hint), // advisory only
  detach: (editor, target) => editor.unmountFrom(target.container), // never stops the editor
});

await surfaces.present('notes-view', 'main-viewport', layerElement);
```

Each surface moves through `unbound`, `binding`, `ready`, `presented`, `hidden`, `error`,
`detaching` and `detached`. An unknown key or a missing adapter leaves an `unbound` placeholder
that keeps the surface's identity and geometry, and binds in place once it can. Bindings resolve
asynchronously with an abort signal and a timeout; a completion that arrives after the surface was
removed or rebound is discarded. `replaceBinding` swaps a surface's endpoint with a safe handoff:
the new endpoint is attached before the change commits, and the old one is released only after.

## Development

The workspace needs Node.js 24 or later and npm.

```sh
npm install     # install the locked development tools
npm run check   # formatting, type checks, lint, tests and build, in that order
npm test        # the test suites only
npm run build   # compile every package to dist/ (ES modules, declarations, source maps)
```

Tests run against each package's TypeScript source, so they need no build first.
