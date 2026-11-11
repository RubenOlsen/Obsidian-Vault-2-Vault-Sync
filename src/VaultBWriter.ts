// ABOUTME: All filesystem access to the destination vault (the only unit that touches B's disk).
// ABOUTME: Writes files, reads for checksumming, and trashes per the destination vault's trashOption.
import fs from 'node:fs/promises';
import path from 'node:path';

export type SystemTrashFn = (fullPath: string) => Promise<void>;

// VERIFY-AT-IMPLEMENTATION: Obsidian desktop (Electron) exposes shell.trashItem;
// confirm against the installed runtime. Tests inject their own, so this is never hit headless.
const defaultSystemTrash: SystemTrashFn = async (fullPath) => {
  // Obsidian exposes the Electron remote proxy at window.electron.remote (same accessor
  // its own Importer plugin uses for dialogs); shell.trashItem routes to the OS trash.
  const remote = window.electron?.remote;
  if (!remote) throw new Error('Electron remote is not available for system trash');
  await remote.shell.trashItem(fullPath);
};

export class VaultBWriter {
  constructor(
    private readonly destVaultPath: string,
    private readonly systemTrash: SystemTrashFn = defaultSystemTrash,
  ) {}

  async writeFile(destAbsPath: string, data: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(destAbsPath), { recursive: true });
    await fs.writeFile(destAbsPath, data);
  }

  async readFileIfExists(destAbsPath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(destAbsPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return null;
      throw err;
    }
  }

  async trashFile(destAbsPath: string): Promise<void> {
    const option = await this.readTrashOption();
    if (option === 'none') {
      await fs.rm(destAbsPath, { force: true });
      return;
    }
    if (option === 'local') {
      const trashDir = path.join(this.destVaultPath, '.trash');
      await fs.mkdir(trashDir, { recursive: true });
      await fs.rename(destAbsPath, path.join(trashDir, path.basename(destAbsPath)));
      return;
    }
    await this.systemTrash(destAbsPath);
  }

  private async readTrashOption(): Promise<'system' | 'local' | 'none'> {
    try {
      const raw = await fs.readFile(path.join(this.destVaultPath, '.obsidian', 'app.json'), 'utf8');
      const option = JSON.parse(raw).trashOption;
      if (option === 'local' || option === 'none') return option;
      return 'system';
    } catch {
      return 'system';
    }
  }
}
