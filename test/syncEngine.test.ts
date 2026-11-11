import { describe, it, expect, beforeEach } from 'vitest';
import { SyncEngine, type SyncDeps, type LogAccess } from '../src/SyncEngine';
import { SettingsStore } from '../src/SettingsStore';
import { md5 } from '../src/Checksum';
import type { PluginData, LogEntry, FolderMapping } from '../src/types';

const DEST = '/B';

function makeHarness(opts: {
  sources?: Record<string, Buffer>;
  destFiles?: Record<string, Buffer>;
  logEntries?: LogEntry[];
  isFile?: (p: string) => boolean;
  destVaultPath?: string;
  nowValue?: number;
} = {}) {
  const sources = opts.sources ?? {};
  const dest: Record<string, Buffer> = { ...(opts.destFiles ?? {}) };
  const notes: string[] = [];
  const logEntries = opts.logEntries ?? [];
  let nowValue = opts.nowValue ?? 1000000000000;

  const data: PluginData = {
    destVaultPath: opts.destVaultPath ?? DEST,
    vaultId: 'vault-a',
    mappings: [{ sourcePath: 'Knowledge', destPath: 'Knowledge', active: true }],
    discoveryDismissed: [],
  };
  const store = new SettingsStore({ load: async () => data, save: async () => {} });

  const log: LogAccess = {
    lastSynced(_mapping: FolderMapping, path: string): string | undefined {
      // Find the latest entry for this path (highest ts)
      let latest: LogEntry | undefined;
      for (const entry of logEntries) {
        if (entry.path === path) {
          if (!latest || entry.ts > latest.ts) {
            latest = entry;
          }
        }
      }
      // Return md5 if latest is not delete, undefined if no entry or latest is delete
      if (!latest || latest.op === 'delete') return undefined;
      return latest.md5;
    },
    loggedPaths(_mapping: FolderMapping): string[] {
      // Return paths whose latest op is NOT delete
      const latestByPath = new Map<string, LogEntry>();
      for (const entry of logEntries) {
        const current = latestByPath.get(entry.path);
        if (!current || entry.ts > current.ts) {
          latestByPath.set(entry.path, entry);
        }
      }
      const result: string[] = [];
      for (const [path, entry] of latestByPath.entries()) {
        if (entry.op !== 'delete') {
          result.push(path);
        }
      }
      return result;
    },
    async append(_mapping: FolderMapping, entry: LogEntry): Promise<void> {
      logEntries.push(entry);
    },
  };

  const writer = {
    written: [] as { path: string; data: Buffer }[],
    trashed: [] as string[],
    async writeFile(p: string, d: Buffer) {
      dest[p] = d;
      this.written.push({ path: p, data: d });
    },
    async readFileIfExists(p: string) {
      return dest[p] ?? null;
    },
    async trashFile(p: string) {
      delete dest[p];
      this.trashed.push(p);
    },
  };

  const deps: SyncDeps = {
    readSource: async (p) => sources[p],
    isFile: opts.isFile ?? (() => true),
    writer,
    log,
    store,
    checksum: md5,
    notify: (m) => notes.push(m),
    now: () => nowValue,
  };

  return {
    deps,
    writer,
    dest,
    notes,
    store,
    log,
    logEntries,
    setNow: (val: number) => { nowValue = val; },
    async init() {
      await store.load();
      return new SyncEngine(deps);
    }
  };
}

describe('SyncEngine.handleUpsert (op-log driven)', () => {
  it('does nothing when source file is unchanged (myMd5 == lastSynced)', async () => {
    const h = makeHarness({
      sources: { 'Knowledge/a.md': Buffer.from('hello') },
      logEntries: [{ ts: 999, op: 'create', path: 'Knowledge/a.md', md5: md5('hello') }],
    });
    const engine = await h.init();
    await engine.handleUpsert('Knowledge/a.md');
    expect(h.writer.written).toHaveLength(0);
    expect(h.logEntries).toHaveLength(1); // No new entry appended
  });

  it('writes file and appends create entry when peer copy is absent', async () => {
    const h = makeHarness({ sources: { 'Knowledge/a.md': Buffer.from('hello') } });
    const engine = await h.init();
    await engine.handleUpsert('Knowledge/a.md');
    expect(h.dest['/B/Knowledge/a.md'].toString()).toBe('hello');
    expect(h.logEntries).toHaveLength(1);
    expect(h.logEntries[0]).toMatchObject({ op: 'create', path: 'Knowledge/a.md', md5: md5('hello') });
  });

  it('appends update without writing when peer md5 == myMd5 (echo-killer)', async () => {
    const h = makeHarness({
      sources: { 'Knowledge/a.md': Buffer.from('content') },
      destFiles: { '/B/Knowledge/a.md': Buffer.from('content') },
      logEntries: [{ ts: 999, op: 'create', path: 'Knowledge/a.md', md5: md5('old') }],
    });
    const engine = await h.init();
    await engine.handleUpsert('Knowledge/a.md');
    expect(h.writer.written).toHaveLength(0); // No write
    expect(h.logEntries).toHaveLength(2);
    expect(h.logEntries[1]).toMatchObject({ op: 'update', path: 'Knowledge/a.md', md5: md5('content') });
  });

  it('overwrites peer and appends update when peer md5 == lastSynced', async () => {
    const h = makeHarness({
      sources: { 'Knowledge/a.md': Buffer.from('v2') },
      destFiles: { '/B/Knowledge/a.md': Buffer.from('v1') },
      logEntries: [{ ts: 999, op: 'create', path: 'Knowledge/a.md', md5: md5('v1') }],
    });
    const engine = await h.init();
    await engine.handleUpsert('Knowledge/a.md');
    expect(h.dest['/B/Knowledge/a.md'].toString()).toBe('v2');
    expect(h.logEntries).toHaveLength(2);
    expect(h.logEntries[1]).toMatchObject({ op: 'update', path: 'Knowledge/a.md', md5: md5('v2') });
  });

  it('writes conflicting-copy and notifies when peer differs from both myMd5 and lastSynced', async () => {
    const h = makeHarness({
      sources: { 'Knowledge/a.md': Buffer.from('my-new') },
      destFiles: { '/B/Knowledge/a.md': Buffer.from('peer-edited') },
      logEntries: [{ ts: 999, op: 'create', path: 'Knowledge/a.md', md5: md5('original') }],
      nowValue: 1731240123456,
    });
    const engine = await h.init();
    await engine.handleUpsert('Knowledge/a.md');
    // Peer copy unchanged
    expect(h.dest['/B/Knowledge/a.md'].toString()).toBe('peer-edited');
    // Conflicting copy written with timestamp (UTC)
    const conflictPath = '/B/Knowledge/a (conflicting-copy 2024-11-10T12-02-03).md';
    expect(h.dest[conflictPath].toString()).toBe('my-new');
    // Notification sent
    expect(h.notes.length).toBeGreaterThan(0);
    // Update logged with my md5
    expect(h.logEntries).toHaveLength(2);
    expect(h.logEntries[1]).toMatchObject({ op: 'update', path: 'Knowledge/a.md', md5: md5('my-new') });
  });

  it('ensures two conflicts at same now() produce distinct filenames', async () => {
    const h = makeHarness({
      sources: {
        'Knowledge/a.md': Buffer.from('my-v1'),
        'Knowledge/b.md': Buffer.from('my-v2'),
      },
      destFiles: {
        '/B/Knowledge/a.md': Buffer.from('peer-a'),
        '/B/Knowledge/b.md': Buffer.from('peer-b'),
      },
      logEntries: [
        { ts: 999, op: 'create', path: 'Knowledge/a.md', md5: md5('orig-a') },
        { ts: 999, op: 'create', path: 'Knowledge/b.md', md5: md5('orig-b') },
      ],
      nowValue: 1731240123456,
    });
    const engine = await h.init();
    await engine.handleUpsert('Knowledge/a.md');
    await engine.handleUpsert('Knowledge/b.md');

    const baseTimestamp = '2024-11-10T12-02-03'; // UTC
    const conflictPathA = `/B/Knowledge/a (conflicting-copy ${baseTimestamp}).md`;
    const conflictPathB = `/B/Knowledge/b (conflicting-copy ${baseTimestamp}).md`;

    expect(h.dest[conflictPathA]).toBeDefined();
    expect(h.dest[conflictPathB]).toBeDefined();
    expect(h.dest[conflictPathA].toString()).toBe('my-v1');
    expect(h.dest[conflictPathB].toString()).toBe('my-v2');
  });

  it('uses counter suffix when base conflicting-copy path already exists', async () => {
    const baseTimestamp = '2024-11-10T12-02-03'; // UTC from nowValue 1731240123456
    const baseConflictPath = `/B/Knowledge/a (conflicting-copy ${baseTimestamp}).md`;

    const h = makeHarness({
      sources: { 'Knowledge/a.md': Buffer.from('my-latest') },
      destFiles: {
        '/B/Knowledge/a.md': Buffer.from('peer-edited'),
        [baseConflictPath]: Buffer.from('first-conflict'), // Base path already exists
      },
      logEntries: [{ ts: 999, op: 'create', path: 'Knowledge/a.md', md5: md5('original') }],
      nowValue: 1731240123456,
    });
    const engine = await h.init();
    await engine.handleUpsert('Knowledge/a.md');

    // Should write to counter-suffixed path, not overwrite base
    const counterPath = `/B/Knowledge/a (conflicting-copy ${baseTimestamp}-1).md`;
    expect(h.dest[counterPath]).toBeDefined();
    expect(h.dest[counterPath].toString()).toBe('my-latest');
    // Base path should remain unchanged
    expect(h.dest[baseConflictPath].toString()).toBe('first-conflict');
    // Original peer copy should remain unchanged
    expect(h.dest['/B/Knowledge/a.md'].toString()).toBe('peer-edited');
  });

  it('ignores folder events', async () => {
    const h = makeHarness({ sources: { 'Knowledge/sub': Buffer.from('') }, isFile: () => false });
    const engine = await h.init();
    await engine.handleUpsert('Knowledge/sub');
    expect(h.writer.written).toHaveLength(0);
    expect(h.logEntries).toHaveLength(0);
  });

  it('ignores files outside any mapping', async () => {
    const h = makeHarness({ sources: { 'Work/secret.md': Buffer.from('x') } });
    const engine = await h.init();
    await engine.handleUpsert('Work/secret.md');
    expect(h.writer.written).toHaveLength(0);
    expect(h.logEntries).toHaveLength(0);
  });

  it('round-trips binary bytes unchanged', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x01]);
    const h = makeHarness({ sources: { 'Knowledge/img.png': bytes } });
    const engine = await h.init();
    await engine.handleUpsert('Knowledge/img.png');
    expect(h.dest['/B/Knowledge/img.png'].equals(bytes)).toBe(true);
  });
});

describe('SyncEngine.handleDelete', () => {
  it('trashes peer copy if present and appends delete entry', async () => {
    const h = makeHarness({
      destFiles: { '/B/Knowledge/a.md': Buffer.from('content') },
      logEntries: [{ ts: 999, op: 'create', path: 'Knowledge/a.md', md5: md5('content') }],
    });
    const engine = await h.init();
    await engine.handleDelete('Knowledge/a.md');
    expect(h.writer.trashed).toContain('/B/Knowledge/a.md');
    expect(h.logEntries).toHaveLength(2);
    expect(h.logEntries[1]).toMatchObject({ op: 'delete', path: 'Knowledge/a.md', md5: md5('content') });
  });

  it('appends delete entry even when peer copy is absent', async () => {
    const h = makeHarness({
      logEntries: [{ ts: 999, op: 'create', path: 'Knowledge/a.md', md5: md5('old') }],
    });
    const engine = await h.init();
    await engine.handleDelete('Knowledge/a.md');
    expect(h.writer.trashed).toHaveLength(0); // Nothing to trash
    expect(h.logEntries).toHaveLength(2);
    expect(h.logEntries[1]).toMatchObject({ op: 'delete', path: 'Knowledge/a.md' });
  });
});

describe('SyncEngine.handleRename', () => {
  it('trashes old path and writes new path with appropriate log entries', async () => {
    const h = makeHarness({
      sources: { 'Knowledge/new.md': Buffer.from('moved') },
      destFiles: { '/B/Knowledge/old.md': Buffer.from('moved') },
      logEntries: [{ ts: 999, op: 'create', path: 'Knowledge/old.md', md5: md5('moved') }],
    });
    const engine = await h.init();
    await engine.handleRename('Knowledge/old.md', 'Knowledge/new.md');
    expect(h.writer.trashed).toContain('/B/Knowledge/old.md');
    expect(h.dest['/B/Knowledge/new.md'].toString()).toBe('moved');
    // Should have delete for old + create for new
    expect(h.logEntries.length).toBeGreaterThanOrEqual(2);
  });
});

describe('SyncEngine.reconcile', () => {
  it('upserts each given source file', async () => {
    const h = makeHarness({
      sources: {
        'Knowledge/a.md': Buffer.from('a'),
        'Knowledge/b.md': Buffer.from('b')
      }
    });
    const engine = await h.init();
    await engine.reconcile(['Knowledge/a.md', 'Knowledge/b.md']);
    expect(h.dest['/B/Knowledge/a.md'].toString()).toBe('a');
    expect(h.dest['/B/Knowledge/b.md'].toString()).toBe('b');
  });

  it('trashes peer copies for logged paths that vanished from source', async () => {
    const h = makeHarness({
      sources: { 'Knowledge/a.md': Buffer.from('a') },
      destFiles: {
        '/B/Knowledge/a.md': Buffer.from('a'),
        '/B/Knowledge/gone.md': Buffer.from('g')
      },
      logEntries: [
        { ts: 999, op: 'create', path: 'Knowledge/a.md', md5: md5('a') },
        { ts: 999, op: 'create', path: 'Knowledge/gone.md', md5: md5('g') },
      ],
    });
    const engine = await h.init();
    await engine.reconcile(['Knowledge/a.md']);
    expect(h.writer.trashed).toContain('/B/Knowledge/gone.md');
    expect(h.dest['/B/Knowledge/a.md'].toString()).toBe('a');
  });
});

describe('SyncEngine with no destination configured', () => {
  it('does not write when destVaultPath is empty', async () => {
    const h = makeHarness({
      sources: { 'Knowledge/a.md': Buffer.from('x') },
      destVaultPath: ''
    });
    const engine = await h.init();
    await engine.handleUpsert('Knowledge/a.md');
    expect(h.writer.written).toHaveLength(0);
    expect(h.logEntries).toHaveLength(0);
  });
});
