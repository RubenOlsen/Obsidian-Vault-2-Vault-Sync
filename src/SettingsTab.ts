// ABOUTME: Settings screen: destination vault path, and add/remove per-folder sync mappings.
// ABOUTME: New folders pre-fill the destination to mirror the source, editable before adding.
import { PluginSettingTab, Setting, TFolder, type App, type TextComponent } from 'obsidian';
import type VaultToVaultSyncPlugin from './main';
import { notify } from './ConflictUI';
import { pickDirectory } from './folderDialog';

export class SyncSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: VaultToVaultSyncPlugin,
  ) {
    super(app, plugin);
  }

  private vaultFolderPaths(): string[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .map((f) => f.path)
      .filter((p) => p !== '/')
      .sort();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const data = this.plugin.store.get();

    let destVaultText!: TextComponent;
    new Setting(containerEl)
      .setName('Destination vault path')
      .setDesc('Folder of the vault that receives synced files.')
      .addText((t) => {
        destVaultText = t;
        t.setPlaceholder('/path/to/destination/vault')
          .setValue(data.destVaultPath)
          .onChange(async (v) => {
            await this.plugin.setDestVaultPath(v.trim());
          });
      })
      .addButton((b) =>
        b.setButtonText('Browse…').onClick(async () => {
          try {
            const picked = pickDirectory(data.destVaultPath);
            if (picked) {
              destVaultText.setValue(picked);
              await this.plugin.setDestVaultPath(picked);
            }
          } catch {
            notify('Native folder picker unavailable; type the path manually.');
          }
        }),
      );

    new Setting(containerEl).setName('Synced folders').setHeading();

    if (data.mappings.length === 0) {
      containerEl.createEl('p', { text: 'No folders synced yet.', cls: 'vvsync-empty' });
    } else {
      const list = containerEl.createDiv({ cls: 'vvsync-folder-list' });
      data.mappings.forEach((m, index) => {
        const row = list.createDiv({ cls: 'vvsync-folder-row' });
        const label = `${m.sourcePath || '/'} → ${m.destPath}`;
        row.createSpan({
          text: m.active ? label : `${label}  (inactive)`,
          cls: m.active ? 'vvsync-folder-label' : 'vvsync-folder-label vvsync-folder-inactive',
          attr: { title: label },
        });

        // Direction dropdown
        const directionSelect = row.createEl('select', { cls: 'vvsync-direction-select' });
        const oneWayOption = directionSelect.createEl('option', { text: 'one-way', value: 'one-way' });
        const twoWayOption = directionSelect.createEl('option', { text: 'two-way', value: 'two-way' });
        directionSelect.value = m.direction || 'one-way';
        directionSelect.onchange = async () => {
          m.direction = directionSelect.value as 'one-way' | 'two-way';
          await this.plugin.store.persist();
        };

        const remove = row.createEl('button', { text: '×', cls: 'vvsync-folder-remove' });
        remove.setAttr('aria-label', `Remove ${m.sourcePath}`);
        remove.onclick = async () => {
          await this.plugin.removeMapping(index);
          this.display();
        };
      });
    }

    new Setting(containerEl).setName('Maintenance').setHeading();
    new Setting(containerEl)
      .setName('Compact sync logs')
      .setDesc('Reduce log size by keeping only the latest entry per file.')
      .addButton((b) =>
        b.setButtonText('Compact').onClick(async () => {
          await this.plugin.compactLogs();
        }),
      );

    new Setting(containerEl).setName('Add a folder').setHeading();

    let sourceInput = '';
    let destInput = '';
    let destEdited = false;
    let destText!: TextComponent;
    let directionInput: 'one-way' | 'two-way' = 'one-way';

    const folderPaths = this.vaultFolderPaths();
    new Setting(containerEl)
      .setName('Source folder')
      .setDesc('Pick a folder in this vault to sync.')
      .addDropdown((d) => {
        d.addOption('', '— select a folder —');
        folderPaths.forEach((p) => d.addOption(p, p));
        d.setValue('').onChange((v) => {
          sourceInput = v;
          if (!destEdited) {
            destInput = v;
            destText.setValue(v);
          }
        });
      });

    new Setting(containerEl)
      .setName('Destination folder')
      .setDesc('Defaults to mirror the source; edit to override.')
      .addText((t) => {
        destText = t;
        t.setPlaceholder('Knowledge').onChange((v) => {
          destEdited = true;
          destInput = v.trim();
        });
      });

    new Setting(containerEl)
      .setName('Sync direction')
      .setDesc('one-way: push this folder to the destination. two-way: also receive the destination vault\'s edits (it must run this plugin too).')
      .addDropdown((d) => {
        d.addOption('one-way', 'one-way');
        d.addOption('two-way', 'two-way');
        d.setValue(directionInput).onChange((v) => {
          directionInput = v as 'one-way' | 'two-way';
        });
      });

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText('Add folder')
        .setCta()
        .onClick(async () => {
          if (!sourceInput) return;
          await this.plugin.addMapping(sourceInput, destInput || sourceInput, directionInput);
          this.display();
        }),
    );
  }
}
