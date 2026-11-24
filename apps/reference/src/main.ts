import { createReferenceApp } from './app.js';
import { parseConfig } from './config.js';

/** What a replaced module hands the next: the disposal of the application it ran. */
interface HotData {
  disposing?: Promise<void>;
}

/** Starts the application in the page's viewport element, configured by the address. */
async function main(): Promise<void> {
  const root = document.getElementById('swf-viewport');
  if (root === null) {
    throw new Error('the page has no #swf-viewport element');
  }
  // In development an edit to the application or the framework replaces the running application
  // in place: the old one is disposed, leaving nothing behind, before the new one starts.
  const hot = import.meta.hot;
  const data = hot?.data as HotData | undefined;
  await data?.disposing;
  const app = await createReferenceApp({ root, config: parseConfig(window.location.search) });
  hot?.dispose((next: HotData) => {
    next.disposing = app.dispose();
  });
}

import.meta.hot?.accept();
await main();
