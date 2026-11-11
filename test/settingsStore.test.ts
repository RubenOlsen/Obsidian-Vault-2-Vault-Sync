import { describe, it, expect } from 'vitest';
import { SettingsStore } from '../src/SettingsStore';
import type { PluginData } from '../src/types';

function makeStore(initial: PluginData | null = null, mintId?: () => string) {
  const saved: PluginData[] = [];
  let data = initial;
  const storage = {
    load: async () => data,
    save: async (d: PluginData) => {
      data = d;
      saved.push(structuredClone(d));
    },
  };
  return { store: new SettingsStore(storage, mintId), saved };
}

describe('SettingsStore', () => {
  it('applies defaults when storage is empty', async () => {
    const { store } = makeStore(null, () => 'test-uuid');
    await store.load();
    const data = store.get();
    expect(data.destVaultPath).toBe('');
    expect(data.mappings).toEqual([]);
    expect(data.vaultId).toBe('test-uuid');
  });

  it('mints and persists vaultId on first load when empty', async () => {
    const { store, saved } = makeStore(null, () => 'generated-uuid');
    await store.load();
    expect(store.getVaultId()).toBe('generated-uuid');
    expect(saved).toHaveLength(1);
    expect(saved[0].vaultId).toBe('generated-uuid');
  });

  it('keeps existing vaultId on subsequent loads', async () => {
    const existing: PluginData = {
      destVaultPath: '/B',
      vaultId: 'existing-uuid',
      mappings: [],
      discoveryDismissed: [],
    };
    const { store, saved } = makeStore(existing, () => 'should-not-be-called');
    await store.load();
    expect(store.getVaultId()).toBe('existing-uuid');
    expect(saved).toHaveLength(0);
  });

  it('getVaultId returns the current vaultId', async () => {
    const { store } = makeStore(null, () => 'my-uuid');
    await store.load();
    expect(store.getVaultId()).toBe('my-uuid');
  });

  it('persist() writes the current data to storage', async () => {
    const existing: PluginData = {
      destVaultPath: '/test',
      vaultId: 'persist-test',
      mappings: [],
      discoveryDismissed: [],
    };
    const { store, saved } = makeStore(existing);
    await store.load();
    store.get().destVaultPath = '/updated';
    await store.persist();
    expect(saved).toHaveLength(1);
    expect(saved[0].destVaultPath).toBe('/updated');
    expect(saved[0].vaultId).toBe('persist-test');
  });

  it('loads existing data as-is', async () => {
    const existing: PluginData = {
      destVaultPath: '/B',
      vaultId: 'loaded-uuid',
      mappings: [{ sourcePath: 'Knowledge', destPath: 'Knowledge', active: true }],
      discoveryDismissed: [],
    };
    const { store } = makeStore(existing);
    await store.load();
    expect(store.get()).toEqual(existing);
  });
});
