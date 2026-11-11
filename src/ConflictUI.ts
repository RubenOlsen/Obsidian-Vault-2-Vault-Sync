// ABOUTME: User-facing prompts and notices for the sync plugin.
// ABOUTME: Wraps Obsidian's Modal and Notice so the engine stays free of UI.
import { App, Modal, Notice, Setting } from 'obsidian';

export function notify(message: string): void {
  new Notice(message);
}

/**
 * Setup-time prompt: offer to move clashing destination files back into the
 * source vault. Resolves true if the user chooses to move them.
 */
export function confirmMoveBack(app: App, conflicts: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let decided = false;

    modal.titleEl.setText('Destination folder already has files');
    modal.contentEl.createEl('p', {
      text: `The destination holds ${conflicts.length} file(s) with the same name but different content. ` +
        'Move them back into the source vault (prefixed "From-Destination-Vault-") so the source becomes the single truth? ' +
        'If you choose No, this folder will not be set up for syncing until you move them yourself.',
    });

    new Setting(modal.contentEl)
      .addButton((b) =>
        b
          .setButtonText('Yes, move them back')
          .setCta()
          .onClick(() => {
            decided = true;
            modal.close();
            resolve(true);
          }),
      )
      .addButton((b) =>
        b.setButtonText('No').onClick(() => {
          decided = true;
          modal.close();
          resolve(false);
        }),
      );

    modal.onClose = () => {
      if (!decided) resolve(false);
    };
    modal.open();
  });
}

/**
 * Propose enabling two-way sync when an incoming sync is detected.
 * Resolves true if the user chooses to enable two-way sync.
 */
export function proposeTwoWay(app: App, folder: string, foreignId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let decided = false;

    modal.titleEl.setText('Incoming sync detected');
    modal.contentEl.createEl('p', {
      text: `Folder "${folder}" receives a one-way sync from vault ${foreignId}. ` +
        'Enable two-way sync so your edits here sync back?',
    });

    new Setting(modal.contentEl)
      .addButton((b) =>
        b
          .setButtonText('Enable two-way')
          .setCta()
          .onClick(() => {
            decided = true;
            modal.close();
            resolve(true);
          }),
      )
      .addButton((b) =>
        b.setButtonText('Keep one-way').onClick(() => {
          decided = true;
          modal.close();
          resolve(false);
        }),
      );

    modal.onClose = () => {
      if (!decided) resolve(false);
    };
    modal.open();
  });
}

/**
 * Suggest running "Compact sync logs" when a folder's op-log grows large.
 */
export function noticeLargeLog(folder: string): void {
  new Notice(`Sync log for "${folder}" is large. Consider running "Compact sync logs" for this folder.`);
}

/**
 * Confirm that log compaction finished for N folder(s).
 */
export function noticeCompacted(folderCount: number): void {
  new Notice(`Compaction finished for ${folderCount} folder(s).`);
}
