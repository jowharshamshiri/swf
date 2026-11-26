import type { ChromeTokens } from '@swf/navigation';

/**
 * The kit's colours window chrome is drawn in (UX-013): frames in the kit's quiet ink, the selected
 * window in its focus ring's, the focused one in its warning ink, names in the editor's ink on the
 * editor's ground. The kit checks each against the grounds it is drawn on, in both appearances.
 * A host that styles the panorama otherwise gives `createNavigation` tokens of its own.
 */
export const KIT_CHROME: ChromeTokens = Object.freeze({
  frame: '--vscode-descriptionForeground',
  selected: '--vscode-focusBorder',
  focused: '--vscode-editorWarning-foreground',
  text: '--vscode-editor-foreground',
  ground: '--vscode-editor-background',
});
