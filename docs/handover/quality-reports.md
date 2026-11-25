# Quality reports

Each report is made by a command in this repository, from the state of one commit. A release
gathers them in its folder, `release/<version>/quality/`, beside its dependency audits; they are
the evidence the release was made on.

| Report                | Made by                                     | Shows                                                                                                                                                                         | In a release                                                  |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| The local check       | `npm run check`                             | The models match their proofs; formatting, types (strict), lint (strict, type-checked), every Node.js test, the package sizes and builds                                      | `quality/check.log`                                           |
| Bundle sizes          | `npm run size`                              | Each package's minified and gzip size, its budget, its change since recorded, and that it tree-shakes                                                                         | `quality/bundle-sizes.txt`                                    |
| API reference         | `npm run api-reference`                     | Every public declaration documented, exported and typed without `any`                                                                                                         | `quality/api-reference.txt`, `api-reference/`                 |
| Browser conformance   | `npm run conformance -- --out <folder>`     | Every browser test and the ten end-to-end acceptance scenarios, per browser, with each browser's version and the machine                                                      | `quality/conformance/` (`conformance.md`, `conformance.json`) |
| Performance benchmark | `npm run bench -- --out <folder>`           | Each budget's verdict on the standard fixture, the stress fixture's growth, every measure's median, 95th percentile and maximum over five trials, with environment and method | `quality/benchmark/` (`benchmark.md` and the records)         |
| Accessibility         | the browser suites (`npm run test:browser`) | WCAG 2.2 A and AA by axe-core and by hand: keyboard order, focus, targets, motion, contrast, announcements, the 320-pixel layout                                              | within `quality/conformance/`                                 |
| Dependencies          | `npm run release`                           | Everything a host installs, with version, licence and integrity; vulnerability audits of that and of the development tools                                                    | `dependencies/`                                               |
| Host install          | `npm run release`                           | The tarballs installed as a host would, compiled strictly and run                                                                                                             | in the release's output                                       |

## Reading them

- **Conformance** passes only when every scenario passed in every browser. A case a browser's
  automation cannot drive (touch and pen outside Chromium, media emulation in Firefox over BiDi)
  is counted as skipped, never as passed ([Browser support](../reference/browser-support.md)).
- **The benchmark's verdicts** count only from the verdict machines: Chrome on the reference
  machine (the `windows-gpu` mg-test plan) and Firefox and WebKit on a Linux desktop. Each run
  first records a control (the page moving one element with no framework); read the framework's
  frame rates against it. A shortened run says so in its method and is not a verdict.
- **Bundle sizes** report a change against the sizes recorded in `size-budgets.json`; a release
  records them, so the change in a pull request is its cost.
