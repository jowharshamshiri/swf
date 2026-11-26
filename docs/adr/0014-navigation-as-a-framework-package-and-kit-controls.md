# 0014. Navigation is a framework package, and its controls a separate package on the host's kit

- **Status:** Accepted
- **Date:** 2026-11-26
- **Requirements:** FR-185, ARCH-020, DLV-009, UX-001 to UX-016

## Context

The reference application is not the final product: its host must show the same navigation and
spatial interaction with its own content. That experience (the view modes and the view moving
between them, focus and its strip, the map and the radar, the overview and search, workspace orbit,
magnetic snapping, semantic depth, composition, the capabilities and their experiments, and the
window operations every control runs) lived in the application, so a host could have it only by
rewriting it. Its controls are Svelte components on the host's UI kit, and a host must be able to
turn each on or off, style it, or replace it with its own.

## Decision

The navigation experience is the framework package `@swf/navigation`: plain TypeScript on the other
packages' public entry points, with no UI framework and no kit, held to the same rules, budget and
documented API as every package. `createNavigation` presents a host's surfaces in the host's
element; what navigation needs to know of the host's windows it is told (`WindowTraits`), and every
action is a named `swf.*` command (`createNavigationCommands`).

The controls are `@swf/navigation-ui` (`ui/navigation`), Svelte components on the wsb UI kit that
use only `@swf/*` entry points, the kit's public entry points and Svelte, which a test enforces
(`apps/reference/test/public-api.test.ts`). Each takes one `NavigationModel`, the reactive binding of
a navigation the host made and attached, and none needs another: a host mounts the ones it wants,
passes the panorama its own notices and empty state, leaves out or replaces the view's controls,
the focus strip, the map and the overview, and a control of its own reads the same model and runs
the same commands. Looks come from the kit's theme; window chrome from the custom properties the
host names (`ChromeTokens`, the kit's by `KIT_CHROME`). What the host says of its content (its words
for a surface and a window, the strip's pictures) it gives the model (`HostContent`).

ADR 0010 holds: no framework package depends on the kit. The controls package is, like the
reference application, built only where the kit is, and a checkout without it leaves both out.

## Alternatives

- **The controls in the reference application, the host copying them.** Two copies that drift.
- **The controls in `@swf/navigation`.** Would tie every host to Svelte and one design system.
- **Headless controls with no components.** Every host would rebuild the same views on the same kit.

## Consequences

The reference application is a host of both packages, as the workbench will be; the host example
(`examples/navigation-host`) is another, with content of its own. Navigation's commands are
`swf.*`; a host's own keep its namespace (the application's `reference.*`).

## Migration impact

A host moving off the kit keeps `@swf/navigation` and writes its controls against
`NavigationModel` or straight against `Navigation`.
