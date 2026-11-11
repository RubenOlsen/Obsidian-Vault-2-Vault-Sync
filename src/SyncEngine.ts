// ABOUTME: Decision logic for syncing source files into the destination vault.
// ABOUTME: Pure of I/O — all filesystem access goes through injected collaborators, so it unit-tests without Obsidian.
import path from 'node:path';
import type { SettingsStore } from './SettingsStore';
import type { FolderMapping, LogEntry } from './types';
import { destAbsolutePath, resolveMapping } from './PathResolver';

export interface WriterLike {
  writeFile(destAbsPath: string, data: Buffer): Promise<void>;
  readFileIfExists(destAbsPath: string): Promise<Buffer | null>;
  trashFile(destAbsPath: string): Promise<void>;
}

export interface LogAccess {
  /** Returns the latest md5 for the given path, or undefined if no entry or latest is delete. */
  lastSynced(mapping: FolderMapping, path: string): string | undefined;
  /** Returns paths whose latest operation is NOT delete. */
  loggedPaths(mapping: FolderMapping): string[];
  /** Appends a log entry for the given mapping. */
  append(mapping: FolderMapping, entry: LogEntry): Promise<void>;
}

export interface SyncDeps {
  readSource(sourcePath: string): Promise<Buffer>;
  isFile(sourcePath: string): boolean;
  writer: WriterLike;
  log: LogAccess;
  store: SettingsStore;
  checksum(data: Buffer): string;
  notify(message: string): void;
  now(): number;
}

/**
 * Generate a colon-free ISO timestamp for conflicting-copy filenames.
 * Format: YYYY-MM-DDTHH-MM-SS (UTC)
 */
function colonFreeTimestamp(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}-${min}-${ss}`;
}

/**
 * Generate a conflicting-copy path with timestamp. If that path already exists
 * in the peer, append a short counter suffix to ensure uniqueness.
 */
async function conflictingCopyPath(
  destAbsPath: string,
  ts: number,
  writer: WriterLike
): Promise<string> {
  const { dir, name, ext } = path.parse(destAbsPath);
  const timestamp = colonFreeTimestamp(ts);
  const basePath = path.join(dir, `${name} (conflicting-copy ${timestamp})${ext}`);

  // If base path doesn't exist, use it
  if ((await writer.readFileIfExists(basePath)) === null) {
    return basePath;
  }

  // Otherwise, append a counter suffix
  for (let i = 1; i < 100; i++) {
    const suffixedPath = path.join(dir, `${name} (conflicting-copy ${timestamp}-${i})${ext}`);
    if ((await writer.readFileIfExists(suffixedPath)) === null) {
      return suffixedPath;
    }
  }

  // Fallback (should be unreachable in practice)
  return basePath;
}

export class SyncEngine {
  constructor(private readonly deps: SyncDeps) {}

  async handleUpsert(sourcePath: string): Promise<void> {
    if (!this.deps.isFile(sourcePath)) return;

    const { mappings, destVaultPath } = this.deps.store.get();
    if (destVaultPath.length === 0) return;
    const mapping = resolveMapping(sourcePath, mappings);
    if (!mapping) return;

    const bytes = await this.deps.readSource(sourcePath);
    const myMd5 = this.deps.checksum(bytes);
    const lastSynced = this.deps.log.lastSynced(mapping, sourcePath);

    // No-op: I have not changed it since last sync
    if (myMd5 === lastSynced) return;

    const destPath = destAbsolutePath(sourcePath, mapping, destVaultPath);
    const existing = await this.deps.writer.readFileIfExists(destPath);

    if (existing === null) {
      // Peer copy absent: create
      await this.deps.writer.writeFile(destPath, bytes);
      await this.deps.log.append(mapping, {
        ts: this.deps.now(),
        op: 'create',
        path: sourcePath,
        md5: myMd5,
      });
    } else {
      const peerMd5 = this.deps.checksum(existing);

      if (peerMd5 === myMd5) {
        // Echo-killer: already converged, no write needed
        await this.deps.log.append(mapping, {
          ts: this.deps.now(),
          op: 'update',
          path: sourcePath,
          md5: myMd5,
        });
      } else if (peerMd5 === lastSynced) {
        // Safe overwrite: peer untouched since last sync
        await this.deps.writer.writeFile(destPath, bytes);
        await this.deps.log.append(mapping, {
          ts: this.deps.now(),
          op: 'update',
          path: sourcePath,
          md5: myMd5,
        });
      } else {
        // Conflict: peer differs from both myMd5 and lastSynced
        const conflictPath = await conflictingCopyPath(destPath, this.deps.now(), this.deps.writer);
        await this.deps.writer.writeFile(conflictPath, bytes);
        this.deps.notify(
          `Conflict: "${sourcePath}" changed in both vaults. Wrote incoming as "${path.basename(conflictPath)}".`
        );
        await this.deps.log.append(mapping, {
          ts: this.deps.now(),
          op: 'update',
          path: sourcePath,
          md5: myMd5,
        });
      }
    }
  }

  async handleDelete(sourcePath: string): Promise<void> {
    const { mappings, destVaultPath } = this.deps.store.get();
    if (destVaultPath.length === 0) return;
    const mapping = resolveMapping(sourcePath, mappings);
    if (!mapping) return;

    const lastSynced = this.deps.log.lastSynced(mapping, sourcePath);
    const destPath = destAbsolutePath(sourcePath, mapping, destVaultPath);
    const existing = await this.deps.writer.readFileIfExists(destPath);

    if (existing !== null) {
      await this.deps.writer.trashFile(destPath);
    }

    await this.deps.log.append(mapping, {
      ts: this.deps.now(),
      op: 'delete',
      path: sourcePath,
      md5: lastSynced ?? '', // Use last-synced md5 or empty if unknown
    });
  }

  async handleRename(oldPath: string, newPath: string): Promise<void> {
    await this.handleDelete(oldPath);
    await this.handleUpsert(newPath);
  }

  /**
   * Push every given source file into the peer, then trash peer copies of files
   * that have a log entry under an active mapping but are no longer in the source
   * (e.g. deleted or renamed while the plugin was off, or a deleted folder).
   */
  async reconcile(sourceFiles: string[]): Promise<void> {
    for (const file of sourceFiles) {
      await this.handleUpsert(file);
    }

    const present = new Set(sourceFiles);
    const { mappings } = this.deps.store.get();

    // For each mapping, check logged paths that are no longer present
    for (const mapping of mappings) {
      if (!mapping.active) continue;

      const loggedPaths = this.deps.log.loggedPaths(mapping);
      for (const loggedPath of loggedPaths) {
        if (!present.has(loggedPath) && resolveMapping(loggedPath, mappings) !== null) {
          await this.handleDelete(loggedPath);
        }
      }
    }
  }
}
