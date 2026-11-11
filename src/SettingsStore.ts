// ABOUTME: Owns the plugin's persisted data (settings, vaultId, mappings).
// ABOUTME: Wraps injected load/save so it tests without Obsidian; prod passes the Plugin's loadData/saveData.
import { randomUUID } from 'node:crypto';
import { DEFAULT_DATA, type PluginData } from './types';

export interface DataStorage {
  load(): Promise<PluginData | null>;
  save(data: PluginData): Promise<void>;
}

export class SettingsStore {
  private data: PluginData = structuredClone(DEFAULT_DATA);

  constructor(
    private readonly storage: DataStorage,
    private readonly mintId: () => string = randomUUID,
  ) {}

  async load(): Promise<void> {
    const loaded = await this.storage.load();
    this.data = loaded
      ? { ...structuredClone(DEFAULT_DATA), ...loaded }
      : structuredClone(DEFAULT_DATA);

    if (!this.data.vaultId) {
      this.data.vaultId = this.mintId();
      await this.persist();
    }
  }

  get(): PluginData {
    return this.data;
  }

  async persist(): Promise<void> {
    await this.storage.save(this.data);
  }

  getVaultId(): string {
    return this.data.vaultId;
  }
}
