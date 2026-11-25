# 0001. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-11-25
- **Requirements:** DLV-012; the change process of the baseline specification (§41)

## Context

The baseline specification closes every material architectural choice and requires that any
change to one revise the affected requirements, contracts and tests, and be recorded with its
alternatives and migration impact. The decisions made while building the framework were recorded
alongside the work, outside the repository, where a maintainer cannot find them.

## Decision

Architecturally significant decisions are recorded in `docs/adr/`, one numbered file each, from
[`template.md`](template.md): context, decision, alternatives, consequences and migration impact.
A record is never rewritten to say something else; a later record supersedes it, and both link to
each other. The [change process](../how-to/change-a-contract.md) requires a record for every
change to a public contract or a closed decision.

## Alternatives

- **Decisions in commit messages and the README only.** Commit messages are not found by topic,
  and the README describes the current behaviour, not the choices behind it or what they cost.
- **One decisions document.** It invites rewriting a decision in place, losing what it replaced.

## Consequences

The records 0002 to 0012 restate the decisions the framework was built on. New decisions are
reviewed with the change that makes them.

## Migration impact

None: it records decisions; it changes no code.
