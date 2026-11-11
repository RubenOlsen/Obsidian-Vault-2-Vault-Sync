// ABOUTME: Filesystem I/O for op-logs (NDJSON) and a LogAccess adapter with in-memory cache.
// ABOUTME: LogIO reads/writes .vaultsync/<vaultId>.ndjson; LogAccess wraps it with a per-mapping cache for sync-time reads.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { FolderMapping, LogEntry, SidecarMeta } from './types';
import { parse, serializeLine, lastSyncedByPath } from './OpLogCodec';
import { SYNC_DIR } from './PathResolver';
import type { LogAccess } from './SyncEngine';
import type { DiscoveredSidecar } from './Discovery';

const META_SUFFIX = '.meta.json';

export class LogIO {
  constructor(
    private peerVaultPath: string,
    private myVaultId: string,
    private myVaultPath: string = '',
    private myVaultName: string = '',
  ) {}

  /**
   * Returns the path to my vault's log file for the given mapping.
   * Format: <peerVaultPath>/<destPath>/.vaultsync/<myVaultId>.ndjson
   */
  logPathFor(mapping: FolderMapping): string {
    return path.join(
      this.peerVaultPath,
      mapping.destPath,
      SYNC_DIR,
      `${this.myVaultId}.ndjson`
    );
  }

  /**
   * Read and parse log entries from my vault's log file for this mapping.
   * Returns [] if the file or directory does not exist.
   */
  async readEntries(mapping: FolderMapping): Promise<LogEntry[]> {
    const logPath = this.logPathFor(mapping);
    try {
      const text = await fs.readFile(logPath, 'utf-8');
      return parse(text);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Append a log entry to my vault's log file for this mapping.
   * Creates the .vaultsync directory if it doesn't exist.
   */
  async append(mapping: FolderMapping, entry: LogEntry): Promise<void> {
    const logPath = this.logPathFor(mapping);
    const dir = path.dirname(logPath);

    // Ensure .vaultsync directory exists
    await fs.mkdir(dir, { recursive: true });

    // Append the serialized entry
    await fs.appendFile(logPath, serializeLine(entry));
  }

  /**
   * Atomically rewrite the log file with the given entries.
   * Writes to a .tmp file first, then renames over the real file.
   */
  async rewrite(mapping: FolderMapping, entries: LogEntry[]): Promise<void> {
    const logPath = this.logPathFor(mapping);
    const tmpPath = logPath + '.tmp';
    const dir = path.dirname(logPath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write to temp file
    const content = entries.map((e) => serializeLine(e)).join('');
    await fs.writeFile(tmpPath, content);

    // Atomic rename
    await fs.rename(tmpPath, logPath);
  }

  /**
   * Scan for foreign vault log files in myVaultPath under the given mapping's source path.
   * Returns vault IDs (filenames without .ndjson) that are NOT myVaultId.
   * Returns [] if the directory does not exist.
   */
  async scanForeignLogs(
    myVaultPath: string,
    mapping: FolderMapping,
  ): Promise<string[]> {
    const syncDir = path.join(myVaultPath, mapping.sourcePath, SYNC_DIR);

    try {
      const files = await fs.readdir(syncDir);
      const foreignIds: string[] = [];

      for (const file of files) {
        if (file.endsWith('.ndjson')) {
          const vaultId = file.slice(0, -7); // Remove .ndjson
          if (vaultId !== this.myVaultId) {
            foreignIds.push(vaultId);
          }
        }
      }

      return foreignIds;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Path to my vault's sidecar meta file for the given mapping.
   * Format: <peerVaultPath>/<destPath>/.vaultsync/<myVaultId>.meta.json
   */
  metaPathFor(mapping: FolderMapping): string {
    return path.join(this.peerVaultPath, mapping.destPath, SYNC_DIR, `${this.myVaultId}${META_SUFFIX}`);
  }

  /**
   * Write (idempotently) my sidecar meta next to my log in the peer vault, so
   * the peer can discover this incoming sync and reconstruct the reverse mapping.
   */
  async writeMeta(mapping: FolderMapping): Promise<void> {
    const metaPath = this.metaPathFor(mapping);
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    const meta: SidecarMeta = {
      vaultPath: this.myVaultPath,
      vaultName: this.myVaultName,
      sourcePath: mapping.sourcePath,
      destPath: mapping.destPath,
    };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  }

  /**
   * Walk myVaultPath for foreign sidecar meta files (`.vaultsync/<id>.meta.json`
   * where id !== myVaultId), at any depth. Skips descending into dot-folders
   * (e.g. .obsidian, .git) but does read the .vaultsync folders themselves.
   * Returns [] if the vault path does not exist.
   */
  async scanForeignMeta(myVaultPath: string): Promise<DiscoveredSidecar[]> {
    const results: DiscoveredSidecar[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err: any) {
        if (err.code === 'ENOENT') return;
        throw err;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        if (entry.name === SYNC_DIR) {
          const syncDir = path.join(dir, entry.name);
          const files = await fs.readdir(syncDir);
          for (const file of files) {
            if (!file.endsWith(META_SUFFIX)) continue;
            const foreignId = file.slice(0, -META_SUFFIX.length);
            if (foreignId === this.myVaultId) continue;
            try {
              const meta: SidecarMeta = JSON.parse(await fs.readFile(path.join(syncDir, file), 'utf-8'));
              results.push({ foreignId, meta });
            } catch {
              // Skip malformed sidecar.
            }
          }
        } else if (!entry.name.startsWith('.')) {
          await walk(path.join(dir, entry.name));
        }
      }
    };

    await walk(myVaultPath);
    return results;
  }
}

/**
 * LogAccess implementation backed by an in-memory cache.
 * Call preload(mapping) before the engine uses lastSynced/loggedPaths for that mapping.
 */
class CachedLogAccess implements LogAccess {
  private cache = new Map<FolderMapping, Map<string, string | null>>();

  constructor(private io: LogIO) {}

  /**
   * Preload the cache for a mapping by reading its log entries.
   * MUST be called before the engine uses lastSynced/loggedPaths for this mapping.
   */
  async preload(mapping: FolderMapping): Promise<void> {
    if (this.cache.has(mapping)) {
      return; // Already loaded
    }

    const entries = await this.io.readEntries(mapping);
    const syncedByPath = lastSyncedByPath(entries);
    this.cache.set(mapping, syncedByPath);
  }

  lastSynced(mapping: FolderMapping, path: string): string | undefined {
    const syncedByPath = this.cache.get(mapping);
    if (!syncedByPath) {
      // Mapping not preloaded: return safe default instead of throwing
      return undefined;
    }

    const value = syncedByPath.get(path);
    // Convert null (delete) to undefined
    return value === null ? undefined : value;
  }

  loggedPaths(mapping: FolderMapping): string[] {
    const syncedByPath = this.cache.get(mapping);
    if (!syncedByPath) {
      // Mapping not preloaded: return safe default instead of throwing
      return [];
    }

    const paths: string[] = [];
    for (const [path, value] of syncedByPath.entries()) {
      // Only include paths whose latest op is NOT delete
      if (value !== null) {
        paths.push(path);
      }
    }
    return paths;
  }

  async append(mapping: FolderMapping, entry: LogEntry): Promise<void> {
    // Write through to disk
    await this.io.append(mapping, entry);

    // Update the cache
    const syncedByPath = this.cache.get(mapping);
    if (!syncedByPath) {
      throw new Error('LogAccess.preload must be called before append');
    }

    // Update the cached value for this path
    const currentEntry = syncedByPath.get(entry.path);
    const currentTs = currentEntry === null ? 0 : (currentEntry ? entry.ts : 0);

    // Only update if this entry is newer (or first)
    if (entry.ts >= currentTs || !syncedByPath.has(entry.path)) {
      syncedByPath.set(entry.path, entry.op === 'delete' ? null : entry.md5);
    }
  }
}

/**
 * Factory function to create a LogAccess adapter backed by LogIO.
 * The caller MUST call preload(mapping) before the engine uses it.
 */
export function createLogAccess(io: LogIO): CachedLogAccess {
  return new CachedLogAccess(io);
}
