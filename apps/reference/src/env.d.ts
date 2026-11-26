declare module 'virtual:reference/debug' {
  import type { Component } from 'svelte';
  import type { ShellModel } from './shell/model.svelte.js';

  /** The debug overlay's view in staging builds and development; none in production builds. */
  export const developer: Component<{ model: ShellModel }> | null;
}

declare module 'virtual:reference/experiments' {
  import type { Component } from 'svelte';
  import type { ShellModel } from './shell/model.svelte.js';

  /**
   * The experiment panel in development, staging and production builds; none in everyday
   * builds, which keep every capability on and the everyday controls.
   */
  export const experiments: Component<{ model: ShellModel }> | null;
}
