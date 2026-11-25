# Examples

Small hosts of the framework, each run by the tests, so each works with the packages as they are.
Build the packages first: `npm run build:packages`.

| Example                                      | Shows                                                                                                                                                | Run                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`kernel.ts`](kernel.ts)                     | Transactions, an atomic refusal, groups, idempotent retries, undo and redo, events, disposal                                                         | `node examples/kernel.ts`                                               |
| [`save-and-restore.ts`](save-and-restore.ts) | A layout and an extension's state saved through a saver, restored into a fresh workspace with its surface as a placeholder, a damaged export refused | `node examples/save-and-restore.ts`                                     |
| [`surface-adapter.ts`](surface-adapter.ts)   | An adapter for a host's own endpoints, checked by the conformance suite                                                                              | `node examples/surface-adapter.ts`                                      |
| [`browser-host/`](browser-host/)             | A page presenting its own elements in a panorama with the DOM backend, loaded through an import map with no bundler                                  | `node examples/browser-host/serve.mjs`, then open the address it prints |

`examples/test/examples.test.ts` runs the Node.js examples in `npm test`, and
`examples/test/browser-host.build.test.ts` opens the browser host in Chromium in
`npm run test:build`.
