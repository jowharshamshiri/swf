# Documentation

The repository's [README](../README.md) introduces the packages and describes how each one
behaves. These pages add what a host's developers, the framework's maintainers and those who
release it need beyond that.

## Learning

- [Your first host page](tutorial/first-host-page.md): build a page that presents its own
  elements in a panorama, step by step.

## Doing

- [Integrate SWF into a host](how-to/integrate-a-host.md): the integration guide, from
  installing the packages to taking everything down.
- [Write a surface adapter](how-to/write-a-surface-adapter.md) for a kind of host content, and
  check it with the conformance suite.
- [Load modules on demand](how-to/load-modules-on-demand.md): projections, backends and
  adapters registered at run time from ES modules the host chooses.
- [Migrate](how-to/migrate.md) saved layouts to a newer snapshot format, an extension's state
  to its newer version, and a host to newer packages.
- [Troubleshoot](how-to/troubleshoot.md) a refused operation, a blank or degraded view, a
  surface that never shows, lost input, a failed save or restore.
- [Release the packages](how-to/release.md) as git refs, push them, and roll a release back.
- [Change a contract](how-to/change-a-contract.md): how a change to a public contract or a
  closed decision is made.

## Looking up

- [API reference](reference/api.md): every public declaration of every package, generated
  from the sources.
- [Lifecycle and ownership](reference/lifecycle-and-ownership.md): what each object owns,
  what disposing it releases, and the order to take a host down in.
- [Browser support](reference/browser-support.md): the supported browsers, what each can and
  cannot do, and the support policy.
- [Versions and compatibility](reference/versions-and-compatibility.md): how packages are
  versioned, what a version promises, and which snapshot formats each reads.
- [Security boundary](reference/security-boundary.md): what the framework guarantees about the
  input it reads and the data it reports.
- [Examples](../examples/README.md): small hosts, each run by the tests.

## Understanding

- [Architecture](explanation/architecture.md): the packages, what each may depend on, and why
  the framework is divided as it is.
- [Architecture decisions](adr/README.md): the decisions that shape the framework, each with
  the alternatives weighed and what changing it would take.

## Handing over

- [Handover pack](handover/README.md): demo recipes, quality reports, the release checklist
  and the known limitations.
