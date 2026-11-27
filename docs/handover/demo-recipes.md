# Demo recipes

Each recipe shows one capability in the reference application. Build and open it first:

```sh
npm ci && npm run build:packages
npm run dev                          # the development server, with the Developer panel
# or: npm run build:staging -w @swf/reference, then open apps/reference/dist/index.html
```

The address picks the scene (`?preset=…&seed=…&backend=…`). Every action below is also a command
in the command list (Ctrl+Shift+P or F1).

## The studio

1. Open the page with nothing in the address (or `?preset=studio`). Thirteen named windows stand
   all the way round the camera: a board of three surfaces straight ahead, eight windows behind
   the camera, some high, some low, near ones showing their content, middle ones a compact preview
   and far ones their labels.
2. Search the Windows view for a category (Research, Planning, Data): windows are found by the
   category the host exposes, as by their colour.

## Guided scenarios

1. Open Scenarios on the left and start one: Put a window behind you, Reach a window you cannot
   see, Change a window's depth, Switch focus between windows, Compose surfaces, or Save and
   restore a layout. It loads the studio; undo brings back the scene it replaced.
2. Do the step due any way you like: it is ticked off once done. Show me does it for you.

## Timing how you find a window

1. Under Find a window in Scenarios, pick a way to navigate and press Start: the task names a
   window, behind you whenever one is.
2. Select it, by the way you picked: the time and your presses and keys are recorded. Run again
   with another way; the runs are summed up by way so they compare.

## A 360° panorama of host content

1. Open `?preset=sparse`. Six windows stand all the way round the camera.
2. Drag the background left and right: the view turns through the full circle.
3. Click into a note and type: notes are the page's own elements, live and editable in place.
4. Drag a window by its frame: it follows the pointer and commits once when released. Press
   Escape during a drag: it goes back.

## Handling windows directly

1. Open the studio. Drag a window by its frame: it moves round you and up or down, the same
   height a pixel however far it is, and the bar above the panorama says where it would be as it
   goes (its angle, distance and height). The inspector's sliders follow it. Let go: one change,
   which Undo in that bar puts back. Drag it all the way round: it comes back where it began.
2. Hold Shift and drag a window down or up: it goes farther or comes nearer along the floor, and
   round you as the pointer goes across. Hold Shift and turn the wheel over it: down is farther,
   the burst of turns one change once the wheel rests.
3. Drag a window's edge: it resizes, keeping its centre.
4. Ctrl-click (⌘-click) a second window: both are selected, and the inspector offers to group
   them under a name, as one change. Delete removes what is selected, with an undo offered.
5. In the inspector, drag the Angle, Distance, Height and frame size sliders: the window
   moves in the panorama as the thumb moves, and letting go is one change. Arrow keys step them;
   a typed number places it exactly.
6. Select the Project Board and press Break into parts: its other two surfaces become windows of
   their own beside it, linked to it by dashed lines in the panorama, on the radar and on the map.
   Recombine parts, from the board or a part, puts them back as one change.
7. With magnetic placement on, drag a window near a spoke (every 15° round you) or a ring (3.8,
   6.3, 9.2 or 12 units out): it snaps there, and the bar says to what. Drop it on a spoke beside
   another window: it moves on to the nearest clear spoke.

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
3. Select a window and choose Focus (or double-press its frame): the view moves to frame it
   readably, and the strip below shows every window, in the order they lie round you, by name
   and picture. Press one in the strip, or use Next window, or the arrows from the strip, to focus
   another; Escape moves back to the mode, camera and projection focus was entered from, exactly.
4. In Overview, every window is a card where it stands round the camera: straight ahead in the
   middle, behind at both edges, higher windows above. Press a card to select it, double-press it
   to focus it; type in the search beside it to fade the cards it leaves out. No mode moves a
   window.

## Navigating with the radar

1. The radar is at the top of the right side in every view: the camera's heading is its arrow,
   what lies behind is shaded, and the wedge is what the panorama shows.
2. Set the field of view above the panorama to 150°: the panorama zooms, and the radar's wedge
   narrows; windows outside it fade on the radar.
3. Drag a window on the radar to the far side of the camera: the panorama shows it move as you
   drag, and it lands behind the camera, in the shaded band at the panorama's edges.
4. Select a window and use its actions: bring it in front of the camera, send it behind, centre the
   view on it, focus it. Arrange round spreads every window round the circle on three rings.
5. With the panorama focused, A and D turn the camera, 1 to 4 show the views and M the map.

## Independent policies

1. Open Experiments. Choose each numbered experiment, 01 to 08: it turns its capability on and
   every other off, sets the view up to show it, and its card at the head of the panel says how to
   try it and what to compare with it off. Turn the switches below on and off in any combination:
   the head says it is a custom combination. Then choose Everything combined, and Reset.
2. With magnetic placement on, drag a window near another: it snaps level with it, and the
   notice says to what; Cancel takes the snap back.
3. With semantic depth on, move windows farther away: distant ones show as labels.
4. With seamless 360° on, drag off one edge of the panorama: the drawn cursor carries on
   from the other edge (the platform pointer itself cannot move, which the notice says).
5. Build with `npm run build:everyday -w @swf/reference` and open `apps/reference/dist/index.html`:
   there is no Experiments view, every capability is on, and the view's controls, the radar and the
   command list are all there.

## Keyboard only

1. Tab to the panorama (its focus ring shows). N and P select windows; Left and Right turn the
   selected one round you and Up and Down raise and lower it, Page Up and Page Down move it out and
   in along the floor, `+` and `-` resize it.
2. Space picks it up; arrows preview the move; Enter puts it down as one undoable change.
3. Ctrl+Z and Ctrl+Shift+Z undo and redo. Tab leaves the panorama.

## Composition

1. Open `?preset=composed`: one window holds three surfaces side by side.
2. Detach a surface into a window of its own, move one into another window, merge two windows,
   regroup a window; each is one undoable step.

## Spaces

1. The tabs across the top of the centre are the spaces: Research, Planning and Studio. Press
   Research: its own windows come in one press. Move a window, turn the view, then press Studio:
   the studio is as it was left, and so is Research when you press it again.
2. Write in a note, switch away and back: the note is the same, with what you wrote.
3. The + at the end of the tabs saves what is on screen as a space of your own, a tab from then
   on. Reload the page with no preset in the address: the space shown last comes back as it was.
4. Export the space shown, change the scene, and import the export: the preview shows what it
   holds before Replace. Import a damaged file: the refusal names the line and column.

## Failures shown truthfully

1. In the Developer panel, simulate a missing, slow and throwing adapter: each surface shows a
   stand-in saying why (unbound, pending, failed).
2. Switch the backend between `dom` and `geometry` at the head of the Developer panel: the scene
   and the positions stay; content moves between backends without reloading.
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
