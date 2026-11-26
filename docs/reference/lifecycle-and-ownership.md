# Lifecycle and ownership

The framework owns spatial presentation state and interaction; the host owns whatever is
presented. This page lists, for each object a host makes, what it owns, what disposing it
releases, and what it never touches. Each declaration's JSDoc in the
[API reference](api.md) states the same for that declaration.

## What the host always owns

- **Content.** Every endpoint an adapter resolves (an element, a video, an editor) and its
  producer. The framework attaches it to a target and takes it out again; it never creates,
  runs, pauses, reloads, stops or reads it. Hints are advice an adapter may ignore.
- **Containers.** The elements the host gives a presenter or input adapter. The framework fills
  them and stops using them when disposed; it never removes them.
- **Its listeners.** Every `subscribe`, `register…` and `watch` returns the function that undoes
  it, safe to call twice. A host that subscribes calls it when it no longer listens; disposing the
  object it subscribed to also ends the subscription.
- **Its stores.** A snapshot store keeps what it was given; the framework never deletes a stored
  snapshot except through `store.delete`.

## What each object owns, and what disposing it does

| Object                         | Made by                             | Owns                                                                                                | Disposed by                                                         | Disposing releases                                                                                                                                                                                                | Never touches                              |
| ------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Workspace                      | `createWorkspace`                   | The scene (nodes, surfaces, cameras, viewports), history, previews, idempotency keys, its listeners | `await workspace.dispose()`                                         | Listeners, previews and history; every later operation is refused with `WORKSPACE_DISPOSED`                                                                                                                       | Anything of the host's                     |
| Surface runtime                | `createSurfaceRuntime(workspace)`   | Each surface's binding state and attachments, registered adapters                                   | `await surfaces.dispose()`                                          | Every attachment (through each adapter's `detach`); its listeners and adapters                                                                                                                                    | The endpoints, which stay as they are      |
| Adapter registration           | `surfaces.registerAdapter`          | Nothing of its own                                                                                  | The returned function                                               | Its surfaces' bindings, which return to `unbound` placeholders                                                                                                                                                    | The endpoints                              |
| Presenter                      | `createPresenter`                   | Its open viewports, their renderer and compositor sessions                                          | `await presenter.dispose()`                                         | Every viewport, as below; its subscriptions                                                                                                                                                                       | The containers                             |
| Presented viewport             | `presenter.open`                    | Its backend sessions and their elements in the container                                            | `await view.dispose()`                                              | Hides its surfaces, releasing each attachment whose endpoint declares `safeDetach`, and releases its backend; returns the surfaces that could not be released (their content leaves with the backend's resources) | The container itself                       |
| Renderer or compositor session | The presenter, through the registry | What the session created (elements, canvases, contexts)                                             | `session.release()`, by the presenter                               | Everything it created                                                                                                                                                                                             | Content it was given                       |
| Interaction router             | `createInteractionRouter`           | Gestures, pointer capture, its policies, commands and input adapters                                | `router.dispose()`                                                  | Cancels every gesture (`view-disposed`), restoring what they previewed; disconnects every input adapter; stops listening                                                                                          | The scene beyond cancelling previews       |
| DOM input                      | `createDomInput`                    | Its listeners on the root element                                                                   | The function `registerInputAdapter` returned, or `router.dispose()` | Every listener it added                                                                                                                                                                                           | The root element                           |
| Virtual cursor                 | `createVirtualCursor`               | Its element in the container                                                                        | `cursor.dispose()`                                                  | Takes its element out                                                                                                                                                                                             | The platform pointer, which it never moves |
| Persistence                    | `createPersistence`                 | Registered policies and extensions, held state of absent owners                                     | `persistence.dispose()`                                             | Its listeners on the workspace, policies and extensions                                                                                                                                                           | Stores and stored snapshots                |
| Saver                          | `createSaver`                       | Its save state                                                                                      | `saver.dispose()`                                                   | Its listeners; a save in flight still settles                                                                                                                                                                     | What the store holds                       |
| Diagnostics                    | `createDiagnostics`                 | Its counters and last errors                                                                        | `diagnostics.dispose()`                                             | Its listeners                                                                                                                                                                                                     | Anything it reports on                     |
| Operation trace                | `createOperationTrace`              | The entries it recorded                                                                             | `trace.dispose()` (and `trace.clear()` to forget)                   | Its listener on the workspace                                                                                                                                                                                     | The workspace                              |
| Navigation                     | `createNavigation`                  | A whole workspace in the host's element: its viewport, input, modes, policies, transitions, search  | `await navigation.dispose()`                                        | Everything it made, the workspace and the host's surfaces detached                                                                                                                                                | The host's element and content             |
| Benchmark host                 | `createBenchmarkHost`               | A whole host on the given containers                                                                | `await host.dispose()`                                              | Everything it made, in the order below                                                                                                                                                                            | The containers                             |
| Resource probe                 | `createResourceProbe`               | Its wrappers on a window's registration functions                                                   | `probe.dispose()`                                                   | Puts the window's functions back                                                                                                                                                                                  | What the page registered                   |

Every `dispose`, `release` and `close` is safe to call more than once and returns the same
outcome each time.

## Taking a host down

Dispose in the reverse order of creation, awaiting each step:

1. stop input: call the function `registerInputAdapter` returned, then `router.dispose()`;
2. stop saving and reporting: `saver.dispose()`, `persistence.dispose()`, `trace.dispose()`,
   `diagnostics.dispose()`;
3. `await presenter.dispose()`: every viewport hides and releases its surfaces and its backend;
4. `await surfaces.dispose()`: every remaining attachment is released;
5. `await workspace.dispose()`.

Disposing the workspace first also ends every operation the others would make on it, but the
attachments and listeners they hold are released only by their own disposal: a host that skips
one keeps what that object holds. The browser suites check that 100 cycles of creating and
disposing a whole host leave no listener, observer, frame request or timer behind.

## Lifecycles

- **Workspace:** `ready` → `disposing` → `disposed`. An operation started from inside an event
  listener is queued and runs after the delivery in progress.
- **Surface:** `unbound`, `binding`, `ready`, `presented`, `hidden`, `error`, `detaching`,
  `detached` ([Binding surfaces](../../README.md#binding-surfaces)). A binding completion that
  arrives after the surface was removed or rebound is discarded by its generation.
- **Gesture:** pressed → in the arena → started → committed once, or cancelled with a reason and
  everything it previewed restored ([Interaction](../../README.md#interaction)).
- **Presented viewport:** opening → open → gone; it is listed once open, its ID is refused while it
  is opening or open, and a viewport that fails to start is disposed, freeing its ID. While its
  record is deleted from the scene it keeps its last frame and presents nothing more, the other
  viewports going on; the host disposes it with the record
  ([Presenting in the browser](../../README.md#presenting-in-the-browser)).
- **Backend handoff:** `active` → `preparing` → `validating` → `swapping` → `active`; any failure
  releases what the candidate made, puts back what moved, was released or was hidden, and returns
  to the previous backend (`presentation-degraded` when none works), naming each surface it could
  not put back. A handoff begins only from `active` or `presentation-degraded`, never while one is
  under way, so the next candidate is tried only after the one in hand failed
  ([Presenting in the browser](../../README.md#presenting-in-the-browser)).
- **Save:** `clean`, `dirty`, `saving`, `failed`; only the store's acknowledgement of the saved
  key and revision makes it `clean` ([Saving layouts](../../README.md#saving-layouts)).

Each of these state machines is a Lean model with its invariants proved
([State machines and decision logic](../../README.md#state-machines-and-decision-logic)).
