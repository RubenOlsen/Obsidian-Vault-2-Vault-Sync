// ABOUTME: Real fs tests for LogIO sidecar meta writing and whole-vault foreign-meta discovery.
// ABOUTME: Uses OS temp directories; no mocks of fs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LogIO } from '../src/LogIO';
import type { FolderMapping, SidecarMeta } from '../src/types';

describe('LogIO sidecar meta', () => {
  let tmpDir: string;
  let peerVaultPath: string;
  let myVaultPath: string;
  const myVaultId = 'vault-abc';

  const mapping: FolderMapping = { sourcePath: 'Src', destPath: 'Dst', active: true };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logio-meta-'));
    peerVaultPath = path.join(tmpDir, 'peer');
    myVaultPath = path.join(tmpDir, 'mine');
    await fs.mkdir(peerVaultPath, { recursive: true });
    await fs.mkdir(myVaultPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writeMeta writes the sidecar with origin path, name, and folders', async () => {
    const io = new LogIO(peerVaultPath, myVaultId, myVaultPath, 'My Vault');
    await io.writeMeta(mapping);

    const metaPath = path.join(peerVaultPath, 'Dst', '.vaultsync', `${myVaultId}.meta.json`);
    const parsed: SidecarMeta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    expect(parsed).toEqual({
      vaultPath: myVaultPath,
      vaultName: 'My Vault',
      sourcePath: 'Src',
      destPath: 'Dst',
    });
  });

  it('writeMeta is idempotent (safe to call twice)', async () => {
    const io = new LogIO(peerVaultPath, myVaultId, myVaultPath, 'My Vault');
    await io.writeMeta(mapping);
    await io.writeMeta(mapping);
    const metaPath = path.join(peerVaultPath, 'Dst', '.vaultsync', `${myVaultId}.meta.json`);
    const parsed: SidecarMeta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    expect(parsed.vaultName).toBe('My Vault');
  });

  it('scanForeignMeta finds foreign sidecars across nested folders and skips our own', async () => {
    // Our own meta — must be skipped.
    await write(myVaultPath, 'Knowledge', myVaultId, {
      vaultPath: '/x', vaultName: 'Me', sourcePath: 'Knowledge', destPath: 'Knowledge',
    });
    // Foreign at top level.
    await write(myVaultPath, 'Knowledge', 'A-id', {
      vaultPath: '/abs/A', vaultName: 'Vault A', sourcePath: 'KnowA', destPath: 'Knowledge',
    });
    // Foreign nested.
    await write(myVaultPath, path.join('Projects', 'Sub'), 'A-id', {
      vaultPath: '/abs/A', vaultName: 'Vault A', sourcePath: 'ProjA', destPath: 'Projects/Sub',
    });

    const io = new LogIO(peerVaultPath, myVaultId, myVaultPath, 'Me');
    const found = await io.scanForeignMeta(myVaultPath);

    const keys = found.map((f) => `${f.foreignId}:${f.meta.destPath}`).sort();
    expect(keys).toEqual(['A-id:Knowledge', 'A-id:Projects/Sub']);
    expect(found.every((f) => f.foreignId === 'A-id')).toBe(true);
  });

  it('scanForeignMeta returns [] when there are no sidecars', async () => {
    const io = new LogIO(peerVaultPath, myVaultId, myVaultPath, 'Me');
    expect(await io.scanForeignMeta(myVaultPath)).toEqual([]);
  });
});

async function write(root: string, folder: string, id: string, meta: SidecarMeta): Promise<void> {
  const dir = path.join(root, folder, '.vaultsync');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.meta.json`), JSON.stringify(meta));
}
