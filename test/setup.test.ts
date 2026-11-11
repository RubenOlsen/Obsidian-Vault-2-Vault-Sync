import { describe, it, expect } from 'vitest';
import { scanSetupConflicts, moveConflictsBackToSource, type SetupDeps } from '../src/setup';
import { md5 } from '../src/Checksum';
import type { FolderMapping } from '../src/types';

const mapping: FolderMapping = { sourcePath: 'Knowledge', destPath: 'Knowledge', active: true };
const SRC = '/A';
const DEST = '/B';

describe('scanSetupConflicts', () => {
  it('flags a destination file with the same name but different content', async () => {
    const deps: SetupDeps = {
      readSource: async () => Buffer.from('source'),
      readDest: async () => Buffer.from('different'),
      checksum: md5,
      move: async () => {},
    };
    const conflicts = await scanSetupConflicts(['Knowledge/a.md'], mapping, DEST, deps);
    expect(conflicts).toEqual(['/B/Knowledge/a.md']);
  });

  it('ignores a destination file with identical content', async () => {
    const deps: SetupDeps = {
      readSource: async () => Buffer.from('same'),
      readDest: async () => Buffer.from('same'),
      checksum: md5,
      move: async () => {},
    };
    expect(await scanSetupConflicts(['Knowledge/a.md'], mapping, DEST, deps)).toEqual([]);
  });

  it('ignores files absent in the destination', async () => {
    const deps: SetupDeps = {
      readSource: async () => Buffer.from('source'),
      readDest: async () => null,
      checksum: md5,
      move: async () => {},
    };
    expect(await scanSetupConflicts(['Knowledge/a.md'], mapping, DEST, deps)).toEqual([]);
  });
});

describe('moveConflictsBackToSource', () => {
  it('moves each dest file into the source folder with the From-Destination-Vault- prefix', async () => {
    const moves: { from: string; to: string }[] = [];
    const deps: SetupDeps = {
      readSource: async () => null,
      readDest: async () => null,
      checksum: md5,
      move: async (from, to) => {
        moves.push({ from, to });
      },
    };
    await moveConflictsBackToSource(['/B/Knowledge/cli/a.md'], mapping, SRC, DEST, deps);
    expect(moves).toEqual([
      { from: '/B/Knowledge/cli/a.md', to: '/A/Knowledge/cli/From-Destination-Vault-a.md' },
    ]);
  });
});

describe('bootstrapTwoWay', () => {
  it('reports a dest file when both exist and differ', async () => {
    const deps: SetupDeps = {
      readSource: async () => Buffer.from('source'),
      readDest: async () => Buffer.from('different'),
      checksum: md5,
      move: async () => {},
    };
    const { bootstrapTwoWay } = await import('../src/setup');
    const conflicts = await bootstrapTwoWay(['Knowledge/a.md'], mapping, DEST, deps);
    expect(conflicts).toEqual(['/B/Knowledge/a.md']);
  });

  it('ignores files when both exist but content is identical', async () => {
    const deps: SetupDeps = {
      readSource: async () => Buffer.from('same'),
      readDest: async () => Buffer.from('same'),
      checksum: md5,
      move: async () => {},
    };
    const { bootstrapTwoWay } = await import('../src/setup');
    const conflicts = await bootstrapTwoWay(['Knowledge/a.md'], mapping, DEST, deps);
    expect(conflicts).toEqual([]);
  });

  it('ignores source-only files (dest absent)', async () => {
    const deps: SetupDeps = {
      readSource: async () => Buffer.from('source'),
      readDest: async () => null,
      checksum: md5,
      move: async () => {},
    };
    const { bootstrapTwoWay } = await import('../src/setup');
    const conflicts = await bootstrapTwoWay(['Knowledge/a.md'], mapping, DEST, deps);
    expect(conflicts).toEqual([]);
  });

  it('ignores dest-only files (source absent)', async () => {
    const deps: SetupDeps = {
      readSource: async () => null,
      readDest: async () => Buffer.from('dest'),
      checksum: md5,
      move: async () => {},
    };
    const { bootstrapTwoWay } = await import('../src/setup');
    const conflicts = await bootstrapTwoWay(['Knowledge/a.md'], mapping, DEST, deps);
    expect(conflicts).toEqual([]);
  });
});
