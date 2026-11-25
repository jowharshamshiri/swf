# 0010. The reference application is built on its future host's UI kit

- **Status:** Accepted
- **Date:** 2026-11-24
- **Requirements:** DLV-009, UX-001 to UX-016

## Context

SWF is to become the central content area of a larger workbench, in which each tab is a window of
one workspace. The reference application demonstrates the framework and its policies, and its
controls must follow that workbench's design system so nothing has to be redone when the framework
moves in.

## Decision

The reference application (`apps/reference`) is built on the workbench's UI kit, reached through
a pinned checkout, with every control and look from the kit. It uses the framework only through
its packages' public entry points, which a test enforces. No framework package depends on
anything of the workbench's.

## Alternatives

- **A UI of its own for the reference application.** Would have to be rebuilt in the kit later.
- **Framework packages using the kit.** Would tie every host to one design system.

## Consequences

The reference application's build needs the pinned kit; the packages do not. The kit's own
development dependencies appear in the repository's install, and are not part of what a host
installs.

## Migration impact

When the framework moves into the workbench, the reference application's shell becomes the
workbench's own; the packages are unaffected.
