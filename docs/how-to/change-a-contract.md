# Change a contract

The framework's public contracts (the packages' exported APIs, the adapter, renderer,
compositor and projection contracts, the snapshot format, the error codes) and its closed
architectural decisions change only through this process, so every change says what it costs
the hosts that rely on them.

1. **Name what changes.** List the requirements the change revises, the public declarations and
   contracts it touches, and the tests that hold them.
2. **Record the decision.** Write an architecture decision record in [`docs/adr/`](../adr/README.md)
   from its template: the context, the decision, the alternatives considered and why each was
   not taken, and the migration impact on hosts, saved layouts and other modules. A decision
   that replaces an earlier one marks the earlier record superseded and links both ways.
3. **Change the tests first.** Change or add the tests that state the new behaviour and see
   them fail on the old code; a conformance suite changes with the contract it checks.
4. **Change the code and its documentation together.** A decision of a state machine or of
   decision logic changes in its Lean model, never in the TypeScript around it
   ([Building and changing the models](../../README.md#building-and-changing-the-models)). The
   JSDoc, the README and these docs describe the result, and `npm run api-reference` must pass.
5. **Carry the data forward.** A change to the snapshot format adds its migration step and
   fixtures of the format it replaces ([Migrate](migrate.md)); an adapter or projection whose
   meaning changes raises the version in its ID.
6. **Version it.** Raise each changed package's version as
   [Versions and compatibility](../reference/versions-and-compatibility.md) says, and say in its
   changelog what changed and what a host must do.
7. **Revise the baseline specification.** A change to a requirement is recorded in a new
   version of the specification the release names in its handover pack.

A content integration (a kind of content, a producer's protocol, a transport) never becomes an
obligation of the framework's core: it lives in an adapter, outside the core packages.
