declare module 'virtual:reference/debug' {
  import type { Component } from 'svelte';
  import type { ShellModel } from './shell/model.svelte.js';

  /** The debug overlay's view in staging builds and development; none in production builds. */
  export const diagnostics: Component<{ model: ShellModel }> | null;
}
