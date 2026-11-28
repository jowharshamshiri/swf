# Changelog of @swf/navigation-ui

Each release of @swf/navigation-ui and what it changed for those who use it. Versions follow
semantic versioning: before 1.0.0, a minor version may change the public API incompatibly and a
patch version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. The navigation controls as Svelte components on the wsb UI kit, each taking a
`NavigationModel` and nothing else: the panorama with its gesture, focus and outcome bars and its
guides, the centre by mode, the view switcher, the view's controls, the radar, the inspector with
each window's actions, the focus strip, the map, the overview with search, and the experiment
panel. A host mounts the ones it wants, leaves out or replaces the view's controls, the focus strip,
the map and the overview, and gives navigation's keys its page (`navigationKey`). The controls'
English messages, every navigation command's name, and the kit's chrome tokens come with them.

The inspector places a window by its angle, its distance along the floor and its height, with no
turn; a window's place is said by its heading, its distance along the floor and its height. The
panorama's key help and the held window's hint offer no turning of a window.

A double press on a window's dot on the radar or the map focuses it, or closes its focus when it is
the window in focus (`MapDrawerOptions.onopen`), as a double press on its title bar in the panorama
and on its card in the overview do.

The key help says the wheel over a title bar brings a window nearer or farther, a scroll sideways
over the background turns the view, and a pinch, or Ctrl and the wheel, widens or narrows it.

`navigationKey` takes every key, those typed in a window's content too, and there takes only the
key that leaves it (`NavigationKeys.leaveContent`, F6 by default, `DEFAULT_NAVIGATION_KEYS`), which
runs `swf.content.leave`. `NavigationModel.contentFocused` says which window's content has the
keyboard, and the messages say how to leave it.

The panorama focuses a window on the router's double press (`pointer.doublePressed`), not on the
browser's `dblclick`: two presses on a window near in time and place, never two drags. A marker on
the map moves past the slop of the pointer that pressed it.

A finger or a pen takes a window's mark on the radar or the map within 22 pixels of it (a 44 pixel
target), a mouse within 12; a double press there reaches as far as the presses before it.

The inspector's sliders hold a value measured a rounding past the room's edge (a distance taken
back from a window's world position at the far wall reads 13.500000000000002): the range reaches the
next step past it. Before, the slider refused the value and the page stopped.
