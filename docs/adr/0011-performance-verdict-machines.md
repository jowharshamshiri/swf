# 0011. Performance verdicts only from named verdict machines

- **Status:** Accepted
- **Date:** 2026-11-24
- **Requirements:** §26, NFR-001 to NFR-008, NFR-022, AN-010

## Context

Frame rates and latencies depend on the machine, the GPU and how the browser is driven. Headless
browsers in virtual machines may composite in software and fail a 60 Hz budget even for a page
that moves one element, which says nothing about the framework.

## Decision

The benchmark measures seeded fixtures over five trials per browser, each read against a control
run of the page moving one plain element with no framework. Verdicts count only from the verdict
machines: Chrome on the reference machine (a Windows guest with an NVIDIA GPU), Firefox and
WebKit on a Linux desktop where they composite at 60 Hz. Other machines' records are observations.
Where a browser's automation cannot measure something (the heap outside Chromium), the record
says "not measurable" rather than passing it.

## Alternatives

- **Verdicts from any machine the suite runs on.** Fails or passes by the machine, not the
  framework.
- **Budgets relaxed to what software compositing reaches.** Would hide real regressions.

## Consequences

A release requires a benchmark record with no budget missed; the release checklist names where
that record comes from.

## Migration impact

Changing the reference machine changes the numbers releases are compared against; the change is
recorded with the first record made on the new machine.
