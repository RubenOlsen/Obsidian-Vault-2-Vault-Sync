// ABOUTME: Obsidian plugin entry point for Vault-to-Vault Sync.
// ABOUTME: Wires settings, the sync engine, and vault event listeners to push source folders into the destination vault.
import { FileSystemAdapter, Plugin, TAbstractFile, TFile, TFolder, normalizePath } from 'obsidian';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SettingsStore, type DataStorage } from './SettingsStore';
import { VaultBWriter } from './VaultBWriter';
import { SyncEngine, type LogAccess } from './SyncEngine';
import { md5 } from './Checksum';
import { notify, confirmMoveBack, proposeTwoWay, noticeLargeLog, noticeCompacted } from './ConflictUI';
import { resolveMapping } from './PathResolver';
import { scanSetupConflicts, moveConflictsBackToSource, bootstrapTwoWay, type SetupDeps } from './setup';
import { SyncSettingsTab } from './SettingsTab';
import type { FolderMapping, PluginData } from './types';
import { LogIO, createLogAccess } from './LogIO';
import { compact } from './OpLogCodec';
import { discoveryProposals } from './Discovery';

/** Threshold for suggesting log compaction. */
const LARGE_LOG_LINES = 2000;

export default class VaultToVaultSyncPlugin extends Plugin {
  store!: SettingsStore;
  private engine!: SyncEngine;
  private logIO!: LogIO;
  private logAccess!: LogAccess & { preload(m: FolderMapping): Promise<void> };
  private discoveryRunning = false;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;

  async onload(): Promise<void> {
    const storage: DataStorage = {
      load: () => this.loadData() as Promise<PluginData | null>,
      save: (d) => this.saveData(d),
    };
    this.store = new SettingsStore(storage);
    await this.store.load();
    this.buildEngine();
    this.registerVaultEvents();
    this.addSettingTab(new SyncSettingsTab(this.app, this));
    this.app.workspace.onLayoutReady(async () => {
      await this.reconcileAll();
      await this.runDiscovery();
    });
  }

  onunload(): void {
    // Vault events are registered via this.registerEvent and auto-detached.
    if (this.discoveryTimer !== null) clearTimeout(this.discoveryTimer);
  }

  buildEngine(): void {
    const destPath = this.store.get().destVaultPath;
    const writer = new VaultBWriter(destPath);
    this.logIO = new LogIO(destPath, this.store.getVaultId(), this.sourceBasePath(), this.app.vault.getName());
    this.logAccess = createLogAccess(this.logIO);
    this.engine = new SyncEngine({
      readSource: async (p) => Buffer.from(await this.app.vault.adapter.readBinary(normalizePath(p))),
      isFile: (p) => this.app.vault.getAbstractFileByPath(p) instanceof TFile,
      writer,
      log: this.logAccess,
      store: this.store,
      checksum: md5,
      notify,
      now: () => Date.now(),
    });
  }

  private configured(): boolean {
    const d = this.store.get();
    return d.destVaultPath.length > 0 && d.mappings.some((m) => m.active);
  }

  private registerVaultEvents(): void {
    const v = this.app.vault;
    this.registerEvent(v.on('create', (f) => this.onUpsert(f)));
    this.registerEvent(v.on('modify', (f) => this.onUpsert(f)));
    this.registerEvent(v.on('delete', (f) => this.onDelete(f)));
    this.registerEvent(v.on('rename', (f, oldPath) => this.onRename(f, oldPath)));
  }

  private onUpsert(f: TAbstractFile): void {
    const isFile = f instanceof TFile;
    const resolved = isFile ? resolveMapping(f.path, this.store.get().mappings) : null;
    // An unmapped file appearing may be an incoming push from a peer; scan for a
    // new sidecar and surface the two-way proposal without waiting for a reload.
    if (isFile && resolved === null) this.scheduleDiscovery();
    if (!this.configured() || !isFile || resolved === null) return;
    void this.engine.handleUpsert(f.path);
  }

  /** Debounced trigger for live discovery after unmapped files appear. */
  private scheduleDiscovery(): void {
    if (this.discoveryTimer !== null) return;
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      void this.runDiscovery();
    }, 1500);
  }

  private onDelete(f: TAbstractFile): void {
    if (!this.configured()) return;
    if (f instanceof TFolder) {
      // A folder delete carries only the folder; reconcile trashes the peer copies
      // of its now-absent files and logs the deletes.
      void this.reconcileAll();
      return;
    }
    void this.engine.handleDelete(f.path);
  }

  private onRename(f: TAbstractFile, oldPath: string): void {
    if (!this.configured()) return;
    if (f instanceof TFolder) {
      // A folder rename moves its whole subtree; reconcile writes the files at
      // their new paths and logs the updates; stale entries remain but are harmless.
      void this.reconcileAll();
      return;
    }
    void this.engine.handleRename(oldPath, f.path);
  }

  async reconcileAll(): Promise<void> {
    if (!this.configured()) return;
    const activeMappings = this.store.get().mappings.filter((m) => m.active);

    // Preload log cache and write the discovery sidecar for each mapping before reconcile
    for (const mapping of activeMappings) {
      await this.logAccess.preload(mapping);
      await this.logIO.writeMeta(mapping);
    }

    await this.engine.reconcile(this.sourceFilesFor(activeMappings));

    // Check log size and suggest compaction if large
    for (const mapping of activeMappings) {
      const entries = await this.logIO.readEntries(mapping);
      if (entries.length > LARGE_LOG_LINES) {
        noticeLargeLog(mapping.sourcePath);
      }
    }
  }

  /**
   * Scan for incoming syncs from other vaults and propose two-way sync.
   * Called after startup reconcile.
   */
  private async runDiscovery(): Promise<void> {
    if (this.discoveryRunning) return;
    this.discoveryRunning = true;
    try {
      // Proactive discovery works even on a freshly-installed, unconfigured vault:
      // a foreign sidecar may exist with no mapping yet.
      await this.proposeIncomingSyncs();

      // Flip an existing one-way mapping to two-way if it is receiving a foreign log.
      if (!this.configured()) return;
      const activeMappings = this.store.get().mappings.filter((m) => m.active);
      for (const mapping of activeMappings) {
        if (mapping.direction === 'two-way' || mapping.dismissed) continue;

        const foreignIds = await this.logIO.scanForeignLogs(this.sourceBasePath(), mapping);
        if (foreignIds.length === 0) continue;

        const accepted = await proposeTwoWay(this.app, mapping.sourcePath, foreignIds[0]);
        if (accepted) {
          mapping.direction = 'two-way';
          await this.store.persist();
        } else {
          mapping.dismissed = true;
          await this.store.persist();
        }
      }
    } finally {
      this.discoveryRunning = false;
    }
  }

  /**
   * Discover foreign sidecars in folders with no mapping yet and offer to set up
   * two-way sync, reconstructing the exact reverse mapping from the sidecar.
   */
  private async proposeIncomingSyncs(): Promise<void> {
    const discovered = await this.logIO.scanForeignMeta(this.sourceBasePath());
    const data = this.store.get();
    const proposals = discoveryProposals(discovered, data.mappings, data.discoveryDismissed);
    if (discovered.length === 0) return;

    for (const p of proposals) {
      const accepted = await proposeTwoWay(this.app, p.folder, p.vaultName);
      if (!accepted) {
        data.discoveryDismissed.push(p.key);
        await this.store.persist();
        continue;
      }

      if (data.destVaultPath.length === 0) {
        data.destVaultPath = p.vaultPath;
      } else if (data.destVaultPath !== p.vaultPath) {
        notify(`Already syncing with another vault; cannot also sync back to "${p.vaultName}".`);
        continue;
      }

      data.mappings.push({
        sourcePath: p.reverse.sourcePath,
        destPath: p.reverse.destPath,
        active: true,
        direction: 'two-way',
      });
      await this.store.persist();
      this.buildEngine();
      await this.reconcileAll();
      notify(`Two-way sync enabled for "${p.folder}".`);
    }
  }

  /**
   * Compact all active mapping logs: keep only the latest entry per path.
   * Called from the settings tab "Compact sync logs" button.
   */
  async compactLogs(): Promise<void> {
    if (!this.configured()) return;
    const activeMappings = this.store.get().mappings.filter((m) => m.active);

    for (const mapping of activeMappings) {
      const entries = await this.logIO.readEntries(mapping);
      const compacted = compact(entries);
      await this.logIO.rewrite(mapping, compacted);
    }

    noticeCompacted(activeMappings.length);
  }

  private sourceFilesFor(mappings: FolderMapping[]): string[] {
    return this.app.vault
      .getFiles()
      .map((f) => f.path)
      .filter((p) => resolveMapping(p, mappings) !== null);
  }

  private sourceBasePath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error('Vault-to-Vault Sync requires a desktop (filesystem) vault.');
  }

  private setupDeps(): SetupDeps {
    return {
      readSource: async (p) => {
        const af = this.app.vault.getAbstractFileByPath(p);
        if (!(af instanceof TFile)) return null;
        return Buffer.from(await this.app.vault.adapter.readBinary(normalizePath(p)));
      },
      readDest: async (destAbs) => {
        try {
          return await fs.readFile(destAbs);
        } catch {
          return null;
        }
      },
      checksum: md5,
      move: async (from, to) => {
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
        await fs.rm(from);
      },
    };
  }

  /** Add a source folder; resolve any setup-time conflict, then activate and sync. */
  async addMapping(sourcePath: string, destPath: string, direction: 'one-way' | 'two-way' = 'one-way'): Promise<void> {
    const data = this.store.get();
    if (data.destVaultPath.length === 0) {
      notify('Set the destination vault path before adding a folder.');
      return;
    }
    const mapping: FolderMapping = { sourcePath, destPath, active: false, direction };
    data.mappings.push(mapping);

    const files = this.sourceFilesFor([{ ...mapping, active: true }]);
    const deps = this.setupDeps();

    if (mapping.direction === 'two-way') {
      // Two-way setup: scan for divergent files, write conflicting-copy for each
      const divergences = await bootstrapTwoWay(files, mapping, data.destVaultPath, deps);
      if (divergences.length > 0) {
        notify(
          `"${sourcePath}" has ${divergences.length} conflicting file(s). ` +
          `Destination copies will be saved as "conflicting-copy-..." when you next reconcile.`
        );
      }
    } else {
      // One-way setup: scan for conflicts, offer to move back
      const conflicts = await scanSetupConflicts(files, mapping, data.destVaultPath, deps);
      if (conflicts.length > 0) {
        const moveBack = await confirmMoveBack(this.app, conflicts);
        if (!moveBack) {
          notify(`"${sourcePath}" saved but inactive: resolve the ${conflicts.length} conflicting file(s) first.`);
          await this.store.persist();
          return;
        }
        await moveConflictsBackToSource(conflicts, mapping, this.sourceBasePath(), data.destVaultPath, deps);
      }
    }

    mapping.active = true;
    await this.store.persist();
    this.buildEngine();

    // Preload all active mappings (delete detection scans them all)
    const allActive = this.store.get().mappings.filter((m) => m.active);
    for (const m of allActive) {
      await this.logAccess.preload(m);
    }
    // Write the discovery sidecar so the peer can find this incoming sync.
    await this.logIO.writeMeta(mapping);
    await this.engine.reconcile(this.sourceFilesFor([mapping]));
    notify(`Syncing "${sourcePath}".`);
  }

  async removeMapping(index: number): Promise<void> {
    this.store.get().mappings.splice(index, 1);
    await this.store.persist();
    this.buildEngine();
  }

  async setDestVaultPath(destVaultPath: string): Promise<void> {
    this.store.get().destVaultPath = destVaultPath;
    await this.store.persist();
    this.buildEngine();
  }
}
