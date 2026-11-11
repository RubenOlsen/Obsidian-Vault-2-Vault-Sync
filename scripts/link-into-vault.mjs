// ABOUTME: Dev helper that symlinks this repo into Vault A's plugins folder.
// ABOUTME: Lets Obsidian load the plugin live from source during development.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginId = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8')).id;

const vaultPlugins = path.resolve(repoRoot, '..', 'vaults', 'Vault A', '.obsidian', 'plugins');
const linkPath = path.join(vaultPlugins, pluginId);

fs.mkdirSync(vaultPlugins, { recursive: true });

if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
  fs.rmSync(linkPath, { recursive: true, force: true });
}

fs.symlinkSync(repoRoot, linkPath, 'dir');
console.log(`Linked ${linkPath} -> ${repoRoot}`);
