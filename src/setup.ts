// ABOUTME: Setup-time conflict handling when adding a source folder whose target already holds files.
// ABOUTME: Detects same-name/different-content clashes and can move them back into the source vault.
import path from 'node:path';
import { destAbsolutePath } from './PathResolver';
import type { FolderMapping } from './types';

export interface SetupDeps {
  readSource(sourceRelPath: string): Promise<Buffer | null>;
  readDest(destAbsPath: string): Promise<Buffer | null>;
  checksum(data: Buffer): string;
  move(fromAbs: string, toAbs: string): Promise<void>;
}

const MOVED_PREFIX = 'From-Destination-Vault-';

export async function scanSetupConflicts(
  sourceFiles: string[],
  mapping: FolderMapping,
  destVaultPath: string,
  deps: SetupDeps,
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const sourceRel of sourceFiles) {
    const destAbs = destAbsolutePath(sourceRel, mapping, destVaultPath);
    const destBytes = await deps.readDest(destAbs);
    if (destBytes === null) continue;
    const srcBytes = await deps.readSource(sourceRel);
    if (srcBytes === null) continue;
    if (deps.checksum(srcBytes) !== deps.checksum(destBytes)) conflicts.push(destAbs);
  }
  return conflicts;
}

export async function moveConflictsBackToSource(
  destPaths: string[],
  mapping: FolderMapping,
  sourceVaultPath: string,
  destVaultPath: string,
  deps: SetupDeps,
): Promise<void> {
  const destRoot = path.join(destVaultPath, mapping.destPath);
  for (const destAbs of destPaths) {
    const rel = path.relative(destRoot, destAbs);
    const relDir = path.dirname(rel);
    const base = path.basename(destAbs);
    const targetAbs = path.join(
      sourceVaultPath,
      mapping.sourcePath,
      relDir === '.' ? '' : relDir,
      MOVED_PREFIX + base,
    );
    await deps.move(destAbs, targetAbs);
  }
}

export async function bootstrapTwoWay(
  sourceFiles: string[],
  mapping: FolderMapping,
  peerVaultPath: string,
  deps: SetupDeps,
): Promise<string[]> {
  const divergences: string[] = [];
  for (const sourceRel of sourceFiles) {
    const destAbs = destAbsolutePath(sourceRel, mapping, peerVaultPath);
    const srcBytes = await deps.readSource(sourceRel);
    if (srcBytes === null) continue;
    const destBytes = await deps.readDest(destAbs);
    if (destBytes === null) continue;
    if (deps.checksum(srcBytes) !== deps.checksum(destBytes)) {
      divergences.push(destAbs);
    }
  }
  return divergences;
}
