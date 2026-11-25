# 0007. Versioned snapshots, migration chains and two-phase restore

- **Status:** Accepted
- **Date:** 2026-11-22
- **Requirements:** FR-160 to FR-170, DATA-010 to DATA-020, API-011

## Context

Layouts must survive reloads, export and import, newer releases and absent content, without the
framework ever owning content. A restore that fails half-way, or a format that cannot evolve,
loses users' layouts.

## Decision

A snapshot is canonical JSON naming its format (`swf.workspace/1`), with a published JSON Schema
and a validator that also enforces what a schema cannot (unit rotations, references, acyclic
hierarchy, nesting depth, size limits). It holds layout, binding keys, policy parameters and
extensions' opaque state under their namespaces, never handles or content. Formats move forward
by migration steps, each reading one format and writing the next on its own copy; fixtures of
every format still read must restore and write back byte for byte. A restore first reads,
migrates and validates on copies, changing nothing; then replaces the scene in one revision.
Surfaces come back as placeholders that keep their binding keys and bind in place. Stores declare
whether saves are atomic and compare-and-swap, and never acknowledge a save that did not land.

## Alternatives

- **Serializing runtime objects.** Couples layouts to the code that made them and can carry
  handles and content.
- **Restoring in place, record by record.** A failure leaves a half-restored workspace.
- **Dropping state the current code does not understand.** Loses newer extensions' state when an
  older page saves.

## Consequences

Rolling back a release keeps saved layouts readable as long as no newer format was written; the
release documentation says how to keep exports across such a step.

## Migration impact

Every format change adds a migration step and fixtures; dropping a format a release reads is an
incompatible change.
