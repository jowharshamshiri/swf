# Load modules on demand

Projections, renderers, compositors, surface adapters, geometry kinds, constraints, interaction
policies and persistence extensions are ordinary JavaScript values that the host registers at
run time through the public APIs. There is no plugin format, manifest or interpreter: a module
is loaded with the platform's own `import()`, when and from where the host decides.

## Load and register a module when it is first needed

```ts
async function enableCanvasFallback() {
  const { GeometryRenderer, LayeredRenderer, LayerCompositor } =
    await import('@swf/backend-geometry');
  const unregisterRenderer = presentation.registerRenderer(
    new LayeredRenderer({
      native: new DomRenderer({ document }),
      geometry: new GeometryRenderer({ projections, drawables: (id) => surfaces.handleOf(id) }),
    }),
  );
  const unregisterCompositor = presentation.registerCompositor(new LayerCompositor());
  return () => {
    unregisterCompositor();
    unregisterRenderer();
  };
}
```

A bundler splits a dynamic import into a chunk of its own, loaded only when the call runs.
Without a bundler, the browser loads the module through the page's import map.

## Load an adapter for content the host adds later

```ts
const loaders: Record<string, () => Promise<{ adapter: SurfaceAdapter }>> = {
  'host.video/1': () => import('./adapters/video.js'),
  'host.map/1': () => import('./adapters/map.js'),
};

const registered = new Set<string>();

async function ensureAdapter(type: string) {
  const load = loaders[type];
  if (load === undefined || registered.has(type)) return; // unknown types stay placeholders
  registered.add(type);
  surfaces.registerAdapter((await load()).adapter);
}

// Load each adapter type the scene names, as surfaces are attached or restored.
for (const surface of workspace.getState().surfaces.values()) {
  void ensureAdapter(surface.adapterTypeId);
}
```

A surface whose adapter is not registered waits as an `unbound` placeholder, keeping its place,
size and binding key, and binds in place as soon as its adapter is registered: a restored
layout can name adapters the page has not loaded yet.

## Rules every module meets

- **Registration validates.** Each registry checks what it is given before using it: a
  projection's contract version, profile, domain and a round trip through a probe view; an
  adapter's ID, methods and capability descriptor; a renderer's or compositor's capabilities. A
  module that fails is refused with an error naming what is wrong, and nothing is registered.
- **IDs are versioned.** Each module has an ID `<name>/<version>` unique in its registry;
  registering a second module under a taken ID is refused. Saved layouts name projections and
  adapters by these IDs, so keep an ID's meaning stable and raise its version when it changes.
- **Registration is undone by its return value.** Every `register…` returns the function that
  unregisters exactly what it registered, safe to call twice. What depended on it degrades
  explicitly: surfaces wait as placeholders, a viewport falls back to its next backend or shows
  why it cannot present.
- **Scopes are narrow.** Hand a module only the scope it needs: `workspace.reader()`,
  `workspace.mutator()`, `workspace.persistence()`, `surfaces.binder()` or
  `presentation.registrar()`.
- **Code the host loads is trusted by the host.** SWF does not sandbox modules: they run with
  the page's authority. Load only modules the host would run anyway, from origins its Content
  Security Policy allows.
