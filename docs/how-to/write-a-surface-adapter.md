# Write a surface adapter

An adapter connects one kind of host content to SWF. It finds an endpoint by its binding key, says
what the endpoint's presentation can do, and puts it into or takes it out of a presentation
target. It never creates, runs or stops the content. The finished adapter of this guide, with
its conformance run, is [`examples/surface-adapter.ts`](../../examples/surface-adapter.ts); a
browser one is in [`examples/browser-host/host.js`](../../examples/browser-host/host.js).

## 1. Name it and declare its capabilities

```ts
import type { SurfaceAdapter, SurfaceCapabilities } from '@swf/surfaces';
import { ADAPTER_API_VERSION } from '@swf/surfaces';

const CAPABILITIES: SurfaceCapabilities = {
  attachStrategy: 'native-dom', // a live element in the page
  nativeInteraction: 'full', // the element handles its own input
  uvAddressing: true,
  transformFidelity: 'approximate',
  transparency: false,
  clipping: true,
  cursorMapping: true,
  resize: 'spatial',
  viewportSharing: 'single-owner', // one element can be in one place at a time
  safeDetach: true, // taking it out of the page while hidden does it no harm
  rebinding: true,
  placeholder: false,
  snapshotHooks: false,
};
```

- `id` is `<name>/<version>`, such as `host.editor/1`, unique among the host's adapters. A
  surface names it as its `adapterTypeId`. Raise the version when the adapter's binding keys
  change meaning.
- `apiVersion` is `ADAPTER_API_VERSION`.
- `declaredCapabilities` is the most the adapter offers. Every field is required and the
  descriptor must not contradict itself: native interaction or `native` fidelity needs the
  `native-dom` strategy, and a `proxy-only` endpoint claims no better than proxy fidelity.
  Registration refuses a contradiction with `UNSUPPORTED_CAPABILITY`, naming it.
- Declare `safeDetach` only when the endpoint survives being taken out of the page (a `<video>`
  keeps playing, an editor keeps its state). Without it, a hidden surface stays attached and
  hidden, and a handoff that would strand it is refused.
- Declare `viewportSharing: 'single-owner'` for an element (it can be in one place only):
  another viewport, or the other side of a seam, then shows a proxy.

## 2. Resolve binding keys

```ts
resolve(bindingKey, signal, context) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return editors.open(bindingKey, { signal }); // null for a key the host does not know
},
capabilities: (editor) => editor.readOnly ? READ_ONLY : CAPABILITIES,
```

- Answer `null` for a key the host does not know: the surface stays an `unbound` placeholder and
  is not an error. Reject only for a real failure; the surface then shows a retryable error.
- Stop work when `signal` aborts: the runtime aborts a binding when the surface is removed or
  rebound, or when `bindingTimeoutMs` passes (set `untimedBinding: true` for an endpoint whose
  setup is expected to take longer; it must still honour the signal). A late answer for a surface
  that moved on is discarded and never attached.
- Each handle's `capabilities` must stay within the declaration. When they change while bound
  (say detachment becomes unsafe), call `context.announceCapabilities(…)`; when the endpoint's
  resource is gone, `context.reportUnavailable(reason)`.

## 3. Attach, hint and detach

```ts
attach(editor, target) {
  target.container.append(editor.element); // the slot the backend gives this surface
},
update(editor, hint) {
  editor.setThrottled(!hint.visible); // advice: the adapter may use it or ignore it
},
detach(editor) {
  editor.element.remove(); // the editor itself keeps running
},
```

- `attach` puts the endpoint into `target.container` (for the DOM backend, an element the
  backend places and clips). A throw or a rejected promise reports a failed mount for that
  surface only.
- `update` receives one advisory hint per frame per viewport: visibility, how much is in view
  and covered, the attention it has. A hint never obliges the content to do anything.
- `detach` takes the endpoint out of that target and nothing more. It is called with exactly the
  handle and target `attach` was given.

## 4. Register it and check it

```ts
const unregister = surfaces.registerAdapter(editorAdapter);
```

Registration validates the adapter and refuses a taken ID with `INVALID_INPUT`. The returned
function unregisters it; the surfaces it had bound become unbound placeholders and bind again when
an adapter of their type is registered.

Run the conformance suite in the host's own tests; it checks binding, unknown and failing keys,
cancellation, timeouts, late answers, detachment, single ownership, replacement and the event
order:

```ts
import { adapterConformance, runConformance } from '@swf/conformance';

const results = await runConformance(
  adapterConformance({
    create: () => editorAdapter,
    keys: { valid: ['doc-1', 'doc-2'], unknown: 'no-such-doc', failing: 'broken', slow: 'pending' },
  }),
);
```

A case whose fixture hook is not given (`slow`, `completeSlow`, `changeCapabilities`) reports
`not-applicable`; give them to run every case.
