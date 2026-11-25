# Handover pack

What a team taking over SWF needs beyond the code and the rest of the documentation.

- **The baseline specification.** SWF implements the Spatial Workspace Framework specification,
  version 1.0 of 20 November 2026, held by its owner outside this repository. Requirement IDs in
  the code, tests and these documents (FR-…, NFR-…, §33.2 and so on) refer to it. A change to a
  requirement is made as [Change a contract](../how-to/change-a-contract.md) says, and recorded in
  a new version of the specification.
- [Demo recipes](demo-recipes.md): how to show each capability in the reference application.
- [Quality reports](quality-reports.md): which reports exist, how each is made, and how to read it.
- [Release checklist](release-checklist.md): every step from a commit to published packages.
- [Known limitations](known-limitations.md): what SWF does not do, or does not do yet, and why.

Every release folder (`release/<version>/`, made by `npm run release`) carries that release's
quality reports, dependency inventory, compatibility matrix and release notes; together with this
pack it is the record of what was handed over.
