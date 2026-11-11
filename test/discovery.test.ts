// ABOUTME: Tests for the pure discovery-proposal helper.
// ABOUTME: Given discovered foreign sidecars, existing mappings, and dismissals, which incoming syncs to propose.
import { describe, it, expect } from 'vitest';
import { discoveryProposals } from '../src/Discovery';
import type { FolderMapping, SidecarMeta } from '../src/types';

function meta(overrides: Partial<SidecarMeta> = {}): SidecarMeta {
  return {
    vaultPath: '/abs/Vault A',
    vaultName: 'Vault A',
    sourcePath: 'Knowledge',
    destPath: 'Knowledge',
    ...overrides,
  };
}

function mapping(sourcePath: string): FolderMapping {
  return { sourcePath, destPath: sourcePath, active: true };
}

describe('discoveryProposals', () => {
  it('proposes an incoming sync with the correct reverse mapping and key', () => {
    const discovered = [{ foreignId: 'A-id', meta: meta() }];
    const proposals = discoveryProposals(discovered, [], []);
    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p.key).toBe('A-id:Knowledge');
    expect(p.foreignId).toBe('A-id');
    expect(p.vaultName).toBe('Vault A');
    expect(p.vaultPath).toBe('/abs/Vault A');
    expect(p.folder).toBe('Knowledge');
    // Reverse: this vault pushes its Knowledge folder back to the origin's source folder.
    expect(p.reverse).toEqual({ sourcePath: 'Knowledge', destPath: 'Knowledge' });
  });

  it('reconstructs a non-mirror reverse mapping from the sidecar', () => {
    const discovered = [{ foreignId: 'A-id', meta: meta({ sourcePath: 'Src', destPath: 'Dst' }) }];
    const proposals = discoveryProposals(discovered, [], []);
    expect(proposals[0].folder).toBe('Dst');
    expect(proposals[0].reverse).toEqual({ sourcePath: 'Dst', destPath: 'Src' });
  });

  it('skips a folder that already has a mapping', () => {
    const discovered = [{ foreignId: 'A-id', meta: meta({ destPath: 'Knowledge' }) }];
    const proposals = discoveryProposals(discovered, [mapping('Knowledge')], []);
    expect(proposals).toHaveLength(0);
  });

  it('skips a dismissed key', () => {
    const discovered = [{ foreignId: 'A-id', meta: meta({ destPath: 'Knowledge' }) }];
    const proposals = discoveryProposals(discovered, [], ['A-id:Knowledge']);
    expect(proposals).toHaveLength(0);
  });
});
