import { describe, it, expect } from 'vitest';
import { resolveMapping, destAbsolutePath } from '../src/PathResolver';
import type { FolderMapping } from '../src/types';

const mirror: FolderMapping = { sourcePath: 'Knowledge', destPath: 'Knowledge', active: true };

describe('resolveMapping', () => {
  it('matches a file inside the mapped folder', () => {
    expect(resolveMapping('Knowledge/cli/git.md', [mirror])).toBe(mirror);
  });

  it('returns null for a file outside any mapping', () => {
    expect(resolveMapping('Work/secret.md', [mirror])).toBeNull();
  });

  it('does not match an inactive mapping', () => {
    const inactive: FolderMapping = { ...mirror, active: false };
    expect(resolveMapping('Knowledge/a.md', [inactive])).toBeNull();
  });

  it('does not match a sibling folder sharing a name prefix', () => {
    expect(resolveMapping('KnowledgeBase/a.md', [mirror])).toBeNull();
  });

  it('paths inside .vaultsync are not managed', () => {
    const m: FolderMapping[] = [{ sourcePath: 'Knowledge', destPath: 'Knowledge', active: true, direction: 'two-way' }];
    expect(resolveMapping('Knowledge/.vaultsync/abc.ndjson', m)).toBeNull();
    expect(resolveMapping('Knowledge/note.md', m)).not.toBeNull();
  });
});

describe('destAbsolutePath', () => {
  it('mirrors the source path under the destination vault', () => {
    expect(destAbsolutePath('Knowledge/cli/git.md', mirror, '/B')).toBe('/B/Knowledge/cli/git.md');
  });

  it('honours an overridden destination folder', () => {
    const override: FolderMapping = { sourcePath: 'Knowledge', destPath: 'Imported/Knowledge', active: true };
    expect(destAbsolutePath('Knowledge/cli/git.md', override, '/B')).toBe('/B/Imported/Knowledge/cli/git.md');
  });
});
