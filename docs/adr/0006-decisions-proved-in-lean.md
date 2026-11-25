# 0006. State machines and decision logic proved in Lean and run as WebAssembly

- **Status:** Accepted
- **Date:** 2026-11-24
- **Requirements:** §13 (state machines), FR-087, FR-104, FR-112, FR-165, NFR-011

## Context

The framework's correctness rests on its state machines (workspace lifecycle, surface
presentation, gestures, saves, backend handoffs) and on decisions that admit, refuse, order or
choose (transaction admission, fallback, picking arbitration, snapshot migration, the reference
application's policies). Tests sample these; they do not show that an invariant holds in every
case.

## Decision

Each state machine and each such decision is a Lean model in `models/`, with its invariants
stated and proved. lungo compiles them into one WebAssembly program, generated into
`packages/models/program/` with a typed API and an assurance record of every claim proved;
`@swf/models` loads it once when first imported and the packages call it synchronously, converting
values at their boundaries. A claim proved with `sorry` fails the build, `npm run check` verifies
that the committed program is what the models generate, and a test checks that every export the
packages call rests only on Lean's standard axioms. A defect in a decision is fixed in its model.

## Alternatives

- **Hand-written TypeScript with property tests.** Finds counterexamples it happens to generate;
  proves nothing, and the decisions drift as code around them changes.
- **A model checker over a separate specification.** Proves the specification, not the code
  that runs.

## Consequences

`@swf/models` is about 40 kB compressed and declared side-effectful (it loads its program). Its
generated declarations are as lungo writes them, which today documents them less than the rest of
the API (0012). Changing a decision requires lungo and Lean (README, "Building and changing the
models").

## Migration impact

Each model's TypeScript boundary is local to the package that calls it: replacing a model with
another implementation changes one boundary, not the packages' public APIs.
