# 0004. Negotiated capabilities and explicit, reported fallback

- **Status:** Accepted
- **Date:** 2026-11-21
- **Requirements:** FR-040 to FR-057, FR-085, FR-087, NFR-013, API-004

## Context

Surfaces, renderers, compositors and projections each can or cannot do things (live interaction,
exact placement, transparency, sharing one endpoint between views, safe detachment). A
presentation that silently does less than asked shows the user something other than what the
host believes it shows.

## Decision

Every module declares its capabilities as data, validated at registration: an adapter's
thirteen-field descriptor, which must not contradict itself, and each handle's capabilities
within it; each renderer's, compositor's and projection's profile. For each fragment of each frame
the planner walks the fallback policy (by default exact, native, approximated, proxy,
placeholder) and reports, per fragment, the mode chosen and why each better one was not
possible. A stand-in says why it stands in. A backend handoff prepares, validates and swaps
before the old backend is released, and keeps the old one on any failure; a viewport with no
working backend shows that it is degraded and why, while the scene keeps taking commands.

## Alternatives

- **Best effort without reporting.** Fast to build; leaves hosts and users unable to tell a
  proxy from live content or a degraded view from an empty one.
- **Refusing to present anything a backend cannot do exactly.** Most panorama content could
  then never be shown live.

## Consequences

Diagnostics can list every fallback with its reason. The fallback and handoff decisions are Lean
models (0006), so their order and their guarantees are proved.

## Migration impact

Adding a capability field is a contract version change: adapters declare the new field, and the
registry refuses descriptors of the other version, naming both.
