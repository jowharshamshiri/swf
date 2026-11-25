# Demo recipes

Each recipe shows one capability in the reference application. Build and open it first:

```sh
npm ci && npm run build:packages
npm run dev                          # the development server, with the Developer panel
# or: npm run build:staging -w @swf/reference, then open apps/reference/dist/index.html
```

The address picks the scene (`?preset=…&seed=…&backend=…`). Every action below is also a command
in the command list (Ctrl+Shift+P or F1).

## A 360° panorama of host content

1. Open `?preset=sparse`. Six windows stand all the way round the camera.
2. Drag the background left and right: the view turns through the full circle.
3. Click into a note and type: notes are the page's own elements, live and editable in place.
4. Drag a window by its frame: it follows the pointer and commits once when released. Press
   Escape during a drag: it goes back.

## The seam behind the camera

1. Open `?preset=seam`. Turn round: windows straddle the seam behind the camera, and one sits
   near the pole above it.
2. Drag a window across the seam: it stays one window, picked as one target, its two halves
   drawn on both edges of the view.

## Hundreds of windows

1. Open `?preset=dense` (250 windows in five rings, the benchmark's scene).
2. Turn the camera and drag windows: frames keep pace. The Developer panel's measures show each
   frame's time, the fragments drawn and the writes made.

## Four views of one scene

1. Use the view-mode switcher: Panorama, Focus, Map, Overview.
2. In Map, drag a window on the ground: the panorama below the map shows it move as you drag.
3. Select a window and choose Focus: it is framed readably, with its neighbours in a row below;
   Escape returns to the mode, camera and projection it was entered from.
4. In Overview, every window is a tile; pressing one selects it. No mode moves a window.

## Independent policies

1. Open Features. Turn each module on and off on its own: focus and context, workspace orbit,
   semantic depth, the wrapped cursor, the map, magnetic placement, multi-surface composition and
   persistence controls; then choose the combined preset, and reset.
2. With magnetic placement on, drag a window near another: it snaps level with it, and the
   notice says to what; Cancel takes the snap back.
3. With semantic depth on, move windows farther away: distant ones show as labels.
4. With the wrapped cursor on, drag off one edge of the panorama: the drawn cursor carries on
   from the other edge (the platform pointer itself cannot move, which the notice says).

## Keyboard only

1. Tab to the panorama (its focus ring shows). N and P select windows; arrows move the selected
   one, Page Up and Page Down change its depth, `[` and `]` turn it, `+` and `-` resize it.
2. Space picks it up; arrows preview the move; Enter puts it down as one undoable change.
3. Ctrl+Z and Ctrl+Shift+Z undo and redo. Tab leaves the panorama.

## Composition

1. Open `?preset=composed`: one window holds three surfaces side by side.
2. Detach a surface into a window of its own, move one into another window, merge two windows,
   regroup a window; each is one undoable step.

## Saved workspaces

1. Rearrange windows, then save the workspace under a name (or let autosave do it).
2. Reload the page with no preset in the address: the last saved workspace comes back, notes
   re-bound in place.
3. Export it, change the scene, and import the export: the preview shows what it holds before
   Replace. Import a damaged file: the refusal names the line and column.

## Failures shown truthfully

1. In the Developer panel, simulate a missing, slow and throwing adapter: each surface shows a
   stand-in saying why (unbound, pending, failed).
2. Switch the backend between `dom` and `geometry`: the scene and the positions stay; content
   moves between backends without reloading.
3. Simulate the backend becoming unavailable: the view says so, drags still move windows, and
   the backend's return shows the committed positions.
4. Open a second view: one element can be live in one view only, and the other shows a proxy
   saying it is elsewhere.

## A host of your own

`examples/browser-host` is a page of its own presenting its own elements with no bundler
([examples](../../examples/README.md)):

```sh
npm run build:packages && node examples/browser-host/serve.mjs
```
