# API reference

The API reference is generated from the packages' sources: every exported function, class,
interface, type, constant, member and signature, with its JSDoc. Each declaration's comment states
what it accepts and refuses (and with which error code or exception), its units and defaults,
who owns what it returns, and what the caller must dispose.

```sh
npm run build:packages
npm run api-reference      # writes api-reference/index.html
```

Every release carries it in `api-reference/` ([Release the packages](../how-to/release.md)).

## What the reference guarantees

`npm run api-reference` fails, naming each problem, when:

- a public declaration, member or signature has no JSDoc;
- a public declaration refers to a type the package does not export;
- a `{@link}` does not resolve;
- a published declaration file (`dist/**/*.d.ts`) states `any`. Values the framework does not
  look into (an endpoint's handle, a backend's container, an extension's state) are `unknown`.

`npm run release` runs it, so no release has an undocumented public declaration.

One part is exempt, and the check reports how much on every run: the declarations of the program
lungo generates into `packages/models/program/`. lungo's TypeScript generator writes no
documentation for their descriptor functions and fields, and types `leanTypes` with `any`. The
decisions themselves are documented in the Lean models in `models/`, where they are proved; the
exemption is removed when lungo carries those docstrings across.

## Entry points

Each package has one entry point, its name; nothing is imported from a package's internal paths.
`@swf/persistence` also publishes its snapshot schema at
`@swf/persistence/schema/swf.workspace-1.schema.json`.

| Package                 | Start with                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `@swf/math`             | `Vec3`, `Quat`, `Transform3D`, `mat4FromTransform`, `ray`, `createRandom`                                |
| `@swf/core`             | `createWorkspace`, `Workspace`, `SceneCommand`, `TxResult`, `SwfError`, `SwfErrorCode`                   |
| `@swf/surfaces`         | `createSurfaceRuntime`, `SurfaceAdapter`, `SurfaceCapabilities`                                          |
| `@swf/presentation`     | `createPresenter`, `createPresentationRegistry`, `planFrame`, `RendererBackend`, `Compositor`            |
| `@swf/projections`      | `createProjectionRegistry`, `equirectangular`, `ProjectionModule`, `pickAt`                              |
| `@swf/interaction`      | `createInteractionRouter`, `InputIntent`, `InteractionPolicy`                                            |
| `@swf/backend-dom`      | `DomRenderer`, `DomCompositor`, `createDomInput`, `animationFrames`                                      |
| `@swf/backend-geometry` | `GeometryRenderer`, `LayeredRenderer`, `LayerCompositor`                                                 |
| `@swf/persistence`      | `createPersistence`, `createSaver`, `createMemoryStore`, `createWebStorageStore`, `createIndexedDbStore` |
| `@swf/diagnostics`      | `createDiagnostics`, `createOperationTrace`, `exportDiagnostics`                                         |
| `@swf/conformance`      | `adapterConformance`, `backendConformance`, `handoffConformance`, `runConformance`                       |
| `@swf/benchmark`        | `planFixture`, `createBenchmarkHost`, `recordFrames`, `summarize`                                        |
| `@swf/models`           | `models` (used by the other packages; a host rarely calls it)                                            |
