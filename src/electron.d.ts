// ABOUTME: Ambient types for the Electron surface Obsidian exposes to plugins.
// ABOUTME: Obsidian attaches the @electron/remote proxy at window.electron.remote (desktop only).
interface ElectronRemote {
  dialog: {
    showOpenDialogSync(options: {
      properties?: string[];
      defaultPath?: string;
      message?: string;
    }): string[] | undefined;
  };
  shell: {
    trashItem(fullPath: string): Promise<void>;
  };
}

interface Window {
  electron?: { remote?: ElectronRemote };
}
