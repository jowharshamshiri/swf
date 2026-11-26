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
