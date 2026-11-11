import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VaultBWriter } from '../src/VaultBWriter';

let destVault: string;

beforeEach(async () => {
  destVault = await fs.mkdtemp(path.join(os.tmpdir(), 'vvsync-'));
});

afterEach(async () => {
  await fs.rm(destVault, { recursive: true, force: true });
});

async function writeAppJson(trashOption: string): Promise<void> {
  const obsidian = path.join(destVault, '.obsidian');
  await fs.mkdir(obsidian, { recursive: true });
  await fs.writeFile(path.join(obsidian, 'app.json'), JSON.stringify({ trashOption }));
}

describe('VaultBWriter.writeFile', () => {
  it('creates intermediate directories and writes exact binary bytes', async () => {
    const writer = new VaultBWriter(destVault);
    const target = path.join(destVault, 'Knowledge', 'cli', 'bin.dat');
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0xfe]);
    await writer.writeFile(target, bytes);
    const read = await fs.readFile(target);
    expect(read.equals(bytes)).toBe(true);
  });
});

describe('VaultBWriter.readFileIfExists', () => {
  it('returns bytes when present and null after removal', async () => {
    const writer = new VaultBWriter(destVault);
    const target = path.join(destVault, 'a.md');
    await fs.writeFile(target, 'hi');
    expect((await writer.readFileIfExists(target))?.toString()).toBe('hi');
    await fs.rm(target);
    expect(await writer.readFileIfExists(target)).toBeNull();
  });

  it('returns null for a directory path rather than throwing', async () => {
    const writer = new VaultBWriter(destVault);
    const dir = path.join(destVault, 'Knowledge');
    await fs.mkdir(dir, { recursive: true });
    expect(await writer.readFileIfExists(dir)).toBeNull();
  });
});

describe('VaultBWriter.trashFile', () => {
  it('local: moves the file into the vault .trash folder', async () => {
    await writeAppJson('local');
    const writer = new VaultBWriter(destVault);
    const target = path.join(destVault, 'Knowledge', 'a.md');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'bye');
    await writer.trashFile(target);
    await expect(fs.access(target)).rejects.toThrow();
    const trashed = path.join(destVault, '.trash', 'a.md');
    expect((await fs.readFile(trashed)).toString()).toBe('bye');
  });

  it('none: deletes the file permanently', async () => {
    await writeAppJson('none');
    const writer = new VaultBWriter(destVault);
    const target = path.join(destVault, 'a.md');
    await fs.writeFile(target, 'bye');
    await writer.trashFile(target);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('falls back to system trash when app.json is missing', async () => {
    const seen: string[] = [];
    const writer = new VaultBWriter(destVault, async (p) => {
      seen.push(p);
    });
    const target = path.join(destVault, 'a.md');
    await fs.writeFile(target, 'bye');
    await writer.trashFile(target);
    expect(seen).toEqual([target]);
  });
});
