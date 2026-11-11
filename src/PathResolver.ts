// ABOUTME: Pure path logic mapping a source file to its owning mapping and destination path.
// ABOUTME: Source paths are vault-relative POSIX; destination paths are absolute, joined via node:path.
import path from 'node:path';
import type { FolderMapping } from './types';

export const SYNC_DIR = '.vaultsync';

function isInside(folder: string, filePath: string): boolean {
  return filePath === folder || filePath.startsWith(folder + '/');
}

export function resolveMapping(
  sourcePath: string,
  mappings: FolderMapping[],
): FolderMapping | null {
  if (sourcePath.split('/').includes(SYNC_DIR)) {
    return null;
  }
  return mappings.find((m) => m.active && isInside(m.sourcePath, sourcePath)) ?? null;
}

export function destAbsolutePath(
  sourcePath: string,
  mapping: FolderMapping,
  destVaultPath: string,
): string {
  const relative = sourcePath.slice(mapping.sourcePath.length + 1);
  return path.join(destVaultPath, mapping.destPath, relative);
}
