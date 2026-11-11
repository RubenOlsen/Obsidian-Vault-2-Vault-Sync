// ABOUTME: Shared data types for the sync plugin (settings, mappings, two-way sync).
// ABOUTME: LogEntry, SyncDirection, and enhanced FolderMapping for two-way sync; vaultId for conflict resolution.

export interface LogEntry {
  /** Unix timestamp (ms) when the operation occurred. */
  ts: number;
  /** Type of operation: create, update, or delete. */
  op: 'create' | 'update' | 'delete';
  /** Source-vault-relative file path. */
  path: string;
  /** MD5 checksum at time of operation. */
  md5: string;
}

export type SyncDirection = 'one-way' | 'two-way';

/**
 * Sidecar written by a pushing vault alongside its op-log, so a destination
 * can discover an incoming sync and reconstruct the exact reverse mapping.
 * Lives at <peerVault>/<destPath>/.vaultsync/<originVaultId>.meta.json.
 */
export interface SidecarMeta {
  /** Absolute filesystem path of the origin (pushing) vault. */
  vaultPath: string;
  /** Display name of the origin vault. */
  vaultName: string;
  /** The origin's source folder (its side of the mapping). */
  sourcePath: string;
  /** The folder in the peer the origin pushes into (this vault's side). */
  destPath: string;
}

export interface FolderMapping {
  /** Source-vault-relative folder path, e.g. "Knowledge". */
  sourcePath: string;
  /** Destination-vault-relative folder path, defaults to mirror the source. */
  destPath: string;
  /** Inactive mappings are saved but not synced (e.g. unresolved setup conflict). */
  active: boolean;
  /** Direction of sync: one-way (source to dest) or two-way (bidirectional); defaults to 'one-way'. */
  direction?: SyncDirection;
  /** Optional flag to indicate conflicts have been reviewed. */
  dismissed?: boolean;
}

export interface PluginData {
  /** Absolute filesystem path to the destination vault root. */
  destVaultPath: string;
  /** Unique identifier for this vault (source vault). */
  vaultId: string;
  mappings: FolderMapping[];
  /**
   * Keys of discovered-but-declined incoming syncs, so proactive discovery
   * does not nag. Key format: `<foreignVaultId>:<folder>`.
   */
  discoveryDismissed: string[];
}

export const DEFAULT_DATA: PluginData = {
  destVaultPath: '',
  vaultId: '',
  mappings: [],
  discoveryDismissed: [],
};
