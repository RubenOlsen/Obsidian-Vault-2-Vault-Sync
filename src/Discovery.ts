// ABOUTME: Pure helper deciding which discovered incoming syncs to propose as two-way.
// ABOUTME: No I/O; takes discovered foreign sidecars, existing mappings, and dismissed keys.
import type { FolderMapping, SidecarMeta } from './types';

export interface DiscoveredSidecar {
  /** The origin vault's id (the sidecar filename without extension). */
  foreignId: string;
  meta: SidecarMeta;
}

export interface DiscoveryProposal {
  /** Dismissal key: `<foreignId>:<folder>`. */
  key: string;
  foreignId: string;
  vaultName: string;
  vaultPath: string;
  /** This vault's folder receiving the incoming sync (meta.destPath). */
  folder: string;
  /** The reverse mapping to create so this vault pushes back to the origin. */
  reverse: { sourcePath: string; destPath: string };
}

/**
 * Decide which discovered incoming syncs to propose. Skips folders already
 * covered by an existing mapping (by source folder) and any dismissed key.
 */
export function discoveryProposals(
  discovered: DiscoveredSidecar[],
  existingMappings: FolderMapping[],
  dismissed: string[],
): DiscoveryProposal[] {
  const mappedFolders = new Set(existingMappings.map((m) => m.sourcePath));
  const dismissedSet = new Set(dismissed);
  const proposals: DiscoveryProposal[] = [];

  for (const { foreignId, meta } of discovered) {
    const folder = meta.destPath;
    const key = `${foreignId}:${folder}`;
    if (mappedFolders.has(folder)) continue;
    if (dismissedSet.has(key)) continue;
    proposals.push({
      key,
      foreignId,
      vaultName: meta.vaultName,
      vaultPath: meta.vaultPath,
      folder,
      reverse: { sourcePath: meta.destPath, destPath: meta.sourcePath },
    });
  }

  return proposals;
}
