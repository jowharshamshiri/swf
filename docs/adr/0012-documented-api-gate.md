# 0012. A generated API reference that fails on an undocumented public declaration

- **Status:** Accepted
- **Date:** 2026-11-25
- **Requirements:** NFR-026, FR-184, DLV-012

## Context

Public interfaces must be documented with their validation rules and their ownership and disposal
obligations, and exported symbols must have no unsafe `any`. A reference that drifts from the code
or skips declarations cannot be relied on.

## Decision

`npm run api-reference` generates the reference of every package with typedoc from the sources and
fails, naming each problem, on a public declaration, member or signature without JSDoc, a public
type left unexported, a link that does not resolve, or `any` in a published declaration file.
`npm run check` and releases run it. The declarations lungo generates for `@swf/models` are
checked like the rest: they carry the Lean models' docstrings, so a model's missing docstring
fails it.

## Alternatives

- **A lint rule requiring JSDoc.** Checks syntax nodes, not what the public API actually exposes
  through re-exports and inferred types.
- **Hand-written reference pages.** Drift from the code with every change.

## Consequences

Every public declaration's comment states what it accepts and refuses and who owns what. Opaque
values are `unknown`.

## Migration impact

None for hosts; a new public declaration needs its JSDoc before it can be released.
