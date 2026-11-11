// ABOUTME: Native OS folder picker via Obsidian's Electron remote, isolated so the rest of the UI stays clean.
// ABOUTME: Uses window.electron.remote.dialog (the pattern Obsidian's own Importer plugin uses); throws if absent so the caller degrades to manual entry.
export function pickDirectory(defaultPath?: string): string | null {
  const remote = window.electron?.remote;
  if (!remote) throw new Error('Electron remote is not available');
  const paths = remote.dialog.showOpenDialogSync({
    properties: ['openDirectory'],
    defaultPath: defaultPath || undefined,
  });
  if (!paths || paths.length === 0) return null;
  return paths[0];
}
