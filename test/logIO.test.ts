// ABOUTME: Real fs tests for LogIO (op-log persistence) and LogAccess (in-memory cache).
// ABOUTME: Uses OS temp directories; no mocks of fs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LogIO, createLogAccess } from '../src/LogIO';
import type { FolderMapping, LogEntry } from '../src/types';

describe('LogIO', () => {
  let tmpDir: string;
  let peerVaultPath: string;
  let myVaultPath: string;
  let io: LogIO;
  const myVaultId = 'vault-abc';
  const otherVaultId = 'vault-xyz';

  const mapping: FolderMapping = {
    sourcePath: 'Knowledge',
    destPath: 'Knowledge',
    active: true,
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logio-test-'));
    peerVaultPath = path.join(tmpDir, 'peer-vault');
    myVaultPath = path.join(tmpDir, 'my-vault');
    await fs.mkdir(peerVaultPath, { recursive: true });
    await fs.mkdir(myVaultPath, { recursive: true });
    io = new LogIO(peerVaultPath, myVaultId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('logPathFor builds correct path', () => {
    const logPath = io.logPathFor(mapping);
    expect(logPath).toBe(
      path.join(peerVaultPath, 'Knowledge', '.vaultsync', 'vault-abc.ndjson')
    );
  });

  it('append then readEntries returns the entry', async () => {
    const entry: LogEntry = {
      ts: Date.now(),
      op: 'create',
      path: 'Knowledge/note.md',
      md5: 'abc123',
    };

    await io.append(mapping, entry);
    const entries = await io.readEntries(mapping);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  it('append multiple entries and read them all', async () => {
    const entry1: LogEntry = {
      ts: 1000,
      op: 'create',
      path: 'Knowledge/note1.md',
      md5: 'abc',
    };
    const entry2: LogEntry = {
      ts: 2000,
      op: 'update',
      path: 'Knowledge/note2.md',
      md5: 'def',
    };

    await io.append(mapping, entry1);
    await io.append(mapping, entry2);

    const entries = await io.readEntries(mapping);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual([entry1, entry2]);
  });

  it('rewrite replaces the log atomically', async () => {
    // First append some entries
    await io.append(mapping, {
      ts: 1000,
      op: 'create',
      path: 'old.md',
      md5: 'old',
    });

    const newEntries: LogEntry[] = [
      { ts: 2000, op: 'update', path: 'new.md', md5: 'new1' },
      { ts: 3000, op: 'update', path: 'new2.md', md5: 'new2' },
    ];

    await io.rewrite(mapping, newEntries);

    const entries = await io.readEntries(mapping);
    expect(entries).toEqual(newEntries);
  });

  it('rewrite ignores leftover .tmp file', async () => {
    const logPath = io.logPathFor(mapping);
    const tmpPath = logPath + '.tmp';

    // Plant a leftover .tmp file
    await fs.mkdir(path.dirname(tmpPath), { recursive: true });
    await fs.writeFile(tmpPath, 'junk\n');

    // Write real entries
    const entries: LogEntry[] = [
      { ts: 1000, op: 'create', path: 'real.md', md5: 'real' },
    ];
    await io.rewrite(mapping, entries);

    // readEntries should ignore the .tmp and read only the real file
    const read = await io.readEntries(mapping);
    expect(read).toEqual(entries);

    // The .tmp should be gone (atomic rename replaced it)
    await expect(fs.access(tmpPath)).rejects.toThrow();
  });

  it('readEntries returns empty array when file does not exist', async () => {
    const entries = await io.readEntries(mapping);
    expect(entries).toEqual([]);
  });

  it('readEntries returns empty array when directory does not exist', async () => {
    const entries = await io.readEntries(mapping);
    expect(entries).toEqual([]);
  });

  it('scanForeignLogs lists other vault ids and skips own', async () => {
    const syncDir = path.join(myVaultPath, 'Knowledge', '.vaultsync');
    await fs.mkdir(syncDir, { recursive: true });

    // Create log files for different vaults
    await fs.writeFile(path.join(syncDir, `${myVaultId}.ndjson`), '');
    await fs.writeFile(path.join(syncDir, `${otherVaultId}.ndjson`), '');
    await fs.writeFile(path.join(syncDir, 'vault-zzz.ndjson'), '');
    // Non-ndjson file should be ignored
    await fs.writeFile(path.join(syncDir, 'notes.txt'), '');

    const foreignIds = await io.scanForeignLogs(myVaultPath, mapping);

    expect(foreignIds.sort()).toEqual(['vault-xyz', 'vault-zzz']);
    expect(foreignIds).not.toContain(myVaultId);
  });

  it('scanForeignLogs returns empty when directory does not exist', async () => {
    const foreignIds = await io.scanForeignLogs(myVaultPath, mapping);
    expect(foreignIds).toEqual([]);
  });

  it('scanForeignLogs returns empty when directory is empty', async () => {
    const syncDir = path.join(myVaultPath, 'Knowledge', '.vaultsync');
    await fs.mkdir(syncDir, { recursive: true });

    const foreignIds = await io.scanForeignLogs(myVaultPath, mapping);
    expect(foreignIds).toEqual([]);
  });
});

describe('LogAccess', () => {
  let tmpDir: string;
  let peerVaultPath: string;
  let io: LogIO;
  const myVaultId = 'vault-test';

  const mapping: FolderMapping = {
    sourcePath: 'Docs',
    destPath: 'Docs',
    active: true,
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logaccess-test-'));
    peerVaultPath = path.join(tmpDir, 'peer');
    await fs.mkdir(peerVaultPath, { recursive: true });
    io = new LogIO(peerVaultPath, myVaultId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('lastSynced returns latest md5 after preload', async () => {
    await io.append(mapping, {
      ts: 1000,
      op: 'create',
      path: 'Docs/a.md',
      md5: 'md5-v1',
    });
    await io.append(mapping, {
      ts: 2000,
      op: 'update',
      path: 'Docs/a.md',
      md5: 'md5-v2',
    });

    const access = createLogAccess(io);
    await access.preload(mapping);

    expect(access.lastSynced(mapping, 'Docs/a.md')).toBe('md5-v2');
  });

  it('lastSynced returns undefined when no entry exists', async () => {
    const access = createLogAccess(io);
    await access.preload(mapping);

    expect(access.lastSynced(mapping, 'Docs/missing.md')).toBeUndefined();
  });

  it('lastSynced returns undefined after delete is latest', async () => {
    await io.append(mapping, {
      ts: 1000,
      op: 'create',
      path: 'Docs/deleted.md',
      md5: 'md5-old',
    });
    await io.append(mapping, {
      ts: 2000,
      op: 'delete',
      path: 'Docs/deleted.md',
      md5: '',
    });

    const access = createLogAccess(io);
    await access.preload(mapping);

    expect(access.lastSynced(mapping, 'Docs/deleted.md')).toBeUndefined();
  });

  it('loggedPaths excludes deleted paths', async () => {
    await io.append(mapping, {
      ts: 1000,
      op: 'create',
      path: 'Docs/a.md',
      md5: 'a',
    });
    await io.append(mapping, {
      ts: 2000,
      op: 'create',
      path: 'Docs/b.md',
      md5: 'b',
    });
    await io.append(mapping, {
      ts: 3000,
      op: 'delete',
      path: 'Docs/b.md',
      md5: '',
    });

    const access = createLogAccess(io);
    await access.preload(mapping);

    const paths = access.loggedPaths(mapping);
    expect(paths).toEqual(['Docs/a.md']);
  });

  it('append updates cache immediately', async () => {
    const access = createLogAccess(io);
    await access.preload(mapping);

    // Append through LogAccess
    await access.append(mapping, {
      ts: 1000,
      op: 'create',
      path: 'Docs/new.md',
      md5: 'new-md5',
    });

    // Should be visible immediately without re-preload
    expect(access.lastSynced(mapping, 'Docs/new.md')).toBe('new-md5');
    expect(access.loggedPaths(mapping)).toContain('Docs/new.md');
  });

  it('append with update overwrites previous entry in cache', async () => {
    await io.append(mapping, {
      ts: 1000,
      op: 'create',
      path: 'Docs/file.md',
      md5: 'v1',
    });

    const access = createLogAccess(io);
    await access.preload(mapping);

    await access.append(mapping, {
      ts: 2000,
      op: 'update',
      path: 'Docs/file.md',
      md5: 'v2',
    });

    expect(access.lastSynced(mapping, 'Docs/file.md')).toBe('v2');
  });

  it('append with delete removes path from loggedPaths', async () => {
    await io.append(mapping, {
      ts: 1000,
      op: 'create',
      path: 'Docs/temp.md',
      md5: 'temp',
    });

    const access = createLogAccess(io);
    await access.preload(mapping);

    expect(access.loggedPaths(mapping)).toContain('Docs/temp.md');

    await access.append(mapping, {
      ts: 2000,
      op: 'delete',
      path: 'Docs/temp.md',
      md5: '',
    });

    expect(access.lastSynced(mapping, 'Docs/temp.md')).toBeUndefined();
    expect(access.loggedPaths(mapping)).not.toContain('Docs/temp.md');
  });

  it('lastSynced and loggedPaths return safe defaults when mapping not preloaded', async () => {
    const access = createLogAccess(io);
    // Do NOT preload the mapping

    // Should return safe defaults, not throw
    expect(access.lastSynced(mapping, 'Docs/any.md')).toBeUndefined();
    expect(access.loggedPaths(mapping)).toEqual([]);
  });
});
