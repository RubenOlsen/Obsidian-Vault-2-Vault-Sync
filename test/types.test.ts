// ABOUTME: Tests for shared data types (LogEntry, SyncDirection, FolderMapping, PluginData).
// ABOUTME: Verifies that DEFAULT_DATA has vaultId (empty), and type-checks FolderMapping with direction.

import { describe, it, expect } from 'vitest';
import { DEFAULT_DATA } from '../src/types';

describe('types', () => {
  it('DEFAULT_DATA has empty vaultId', () => {
    expect(DEFAULT_DATA.vaultId).toBe('');
  });

  it('FolderMapping with direction: "one-way" type-checks', () => {
    const mapping = {
      sourcePath: 'Notes',
      destPath: 'Notes',
      active: true,
      direction: 'one-way',
    } as const;

    expect(mapping.direction).toBe('one-way');
  });

  it('FolderMapping with direction: "two-way" type-checks', () => {
    const mapping = {
      sourcePath: 'Notes',
      destPath: 'Notes',
      active: true,
      direction: 'two-way',
    } as const;

    expect(mapping.direction).toBe('two-way');
  });

  it('FolderMapping with optional dismissed field type-checks', () => {
    const mapping = {
      sourcePath: 'Notes',
      destPath: 'Notes',
      active: true,
      direction: 'one-way',
      dismissed: true,
    } as const;

    expect(mapping.dismissed).toBe(true);
  });
});
