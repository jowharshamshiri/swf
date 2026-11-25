# Changelog of @swf/models

Each release of @swf/models and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. The framework's and the reference application's state machines and decision logic, written in Lean with their invariants proved, and compiled by lungo into one WebAssembly program that this package loads once when it is first imported. Only the packages that decide something through it depend on it.
