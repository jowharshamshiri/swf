# Architecture decisions

Each record states one decision that shapes the framework: its context, the decision, the
alternatives weighed and why each was not taken, and what changing it would cost. A decision is
changed only by a new record that supersedes it ([Change a contract](../how-to/change-a-contract.md));
records are never rewritten to say something else.

To add one, copy [`template.md`](template.md) to the next number with a short title.

| Record                                                        | Decision                                                                        | Status   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md)                 | Record architecture decisions                                                   | Accepted |
| [0002](0002-canonical-scene-separate-from-presentation.md)    | A canonical 3D scene, separate from every presentation of it                    | Accepted |
| [0003](0003-two-presentation-paths-with-declared-fidelity.md) | Two presentation paths, live DOM and drawn geometry, with declared fidelity     | Accepted |
| [0004](0004-negotiated-capabilities-and-explicit-fallback.md) | Negotiated capabilities and explicit, reported fallback                         | Accepted |
| [0005](0005-atomic-revisioned-transactions.md)                | Atomic, revisioned transactions with undo as a new commit                       | Accepted |
| [0006](0006-decisions-proved-in-lean.md)                      | State machines and decision logic proved in Lean and run as WebAssembly         | Accepted |
| [0007](0007-versioned-snapshots-with-two-phase-restore.md)    | Versioned snapshots, migration chains and two-phase restore                     | Accepted |
| [0008](0008-esm-packages-without-a-bundler.md)                | ES module packages compiled without a bundler, tree-shakeable and size-budgeted | Accepted |
| [0009](0009-independent-versions-with-exact-sibling-pins.md)  | Independent package versions with exact sibling pins, released from one commit  | Accepted |
| [0010](0010-reference-application-on-the-host-ui-kit.md)      | The reference application is built on its future host's UI kit                  | Accepted |
| [0011](0011-performance-verdict-machines.md)                  | Performance verdicts only from named verdict machines                           | Accepted |
| [0012](0012-documented-api-gate.md)                           | A generated API reference that fails on an undocumented public declaration      | Accepted |
