# Changelog of @swf/surfaces

Each release of @swf/surfaces and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. Binds the scene's surface associations to the host's presentation endpoints through registered adapters, negotiates each endpoint's capabilities, and drives every surface through its presentation lifecycle. It never inspects, decodes or runs what an endpoint shows, and releasing a surface never stops the endpoint's producer.

An adapter's `resolve` receives its abort signal typed as `BindingSignal`, the part of the
platform's `AbortSignal` every runtime provides, in place of the ambient `AbortSignal`. This is a
type-only change to the adapter contract: the runtime passes a real `AbortSignal`, and an adapter
that declares the parameter as `AbortSignal` compiles as before.

A replacement's binding context carries the generation the handoff commits as, and
`replaceBinding` refuses a single-owner endpoint another surface presents, as `present` does.
