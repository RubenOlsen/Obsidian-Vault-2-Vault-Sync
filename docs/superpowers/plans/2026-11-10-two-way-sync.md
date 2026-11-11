# Two-Way Vault Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in two-way sync between two same-machine vaults, built as a symmetric push with a per-folder append-only op-log, keeping one-way the default.

**Architecture:** Each vault pushes its own changes into the peer (bytes + a conflict check), and records what it pushed in an NDJSON op-log shipped into the peer at `<peerVault>/<destPath>/.vaultsync/<my-id>.ndjson`. Last-synced md5 comes from that log (it replaces the old `baseline` map). Two-way is both vaults running the same push against each other; the md5-equality case kills echoes. No pull, no cursors, no tombstone retention (deletes apply to disk immediately).

**Tech Stack:** TypeScript, esbuild, Vitest, Node `fs`/`crypto`, Obsidian plugin API.

**Spec:** `docs/superpowers/specs/2026-11-10-two-way-sync-design.md`

## Global Constraints

- `SyncEngine` and `OpLogCodec` stay free of `fs`/Obsidian; all I/O is injected (existing pattern).
- Hand-written source files start with two `ABOUTME:` comment lines.
- Log format is append-only NDJSON, one object per line: `{ts:number, op:"create"|"update"|"delete", path:string, md5:string}`.
- A vault's own log lives in the peer: `<peerVault>/<destPath>/.vaultsync/<my-id>.ndjson`. `.vaultsync/` is a dot-folder.
- Conflicting-copy filename uses a colon-free timestamp: `name (conflicting-copy YYYY-MM-DDTHH-MM-SS).ext`.
- No backward-compat for the dropped `baseline` map; the plugin is not in production.
- `npm run check` (tsc + build + Vitest) must pass before a task is done.

## Review Focus

- **`.vaultsync/` must never be treated as syncable content** — if `resolveMapping`/`getFiles` ever returns a path inside it, the log re-syncs itself and recurses. Pinned in Task 2 (PathResolver guard) tests.
- **Corrupt/torn trailing log line** after a crash — `OpLogCodec.parse` must skip it, not throw. Pinned in Task 3.
- **Identical file on both sides** (peer md5 == my md5) must converge silently, never make a conflicting-copy — the echo-killer. Pinned in Task 4.
- **Missing/invalid peer vault path** — a push must fail soft (notify), not crash the plugin. Pinned in Task 6 (LogIO) tests.
- **Two conflicts on the same file within one second** must not clobber each other's conflicting-copy — the timestamp needs sub-second disambiguation or a uniqueness check. Pinned in Task 4.

---

### Task 1: Data types and log entry

**Files:**
- Modify: `src/types.ts`
- Test: `src/types.test.ts` (new)

**Interfaces:**
- Produces: `LogEntry { ts: number; op: 'create'|'update'|'delete'; path: string; md5: string }`; `SyncDirection = 'one-way'|'two-way'`; `FolderMapping` gains `direction: SyncDirection` and `dismissed?: boolean`; `PluginData` gains `vaultId: string`, drops `baseline`; `DEFAULT_DATA` updated (`vaultId: ''`).

- [ ] **Step 1: Write the failing test** — assert `DEFAULT_DATA` has `vaultId: ''`, `mappings: []`, and no `baseline` key; assert a `FolderMapping` literal with `direction: 'one-way'` type-checks.

```ts
test('DEFAULT_DATA has vaultId and no baseline', () => {
  expect(DEFAULT_DATA.vaultId).toBe('');
  expect('baseline' in DEFAULT_DATA).toBe(false);
});
```

- [ ] **Step 2: Run test, verify it fails** — `npx vitest run src/types.test.ts`. Expected: FAIL (baseline still present).
- [ ] **Step 3: Edit `src/types.ts`** — add `LogEntry`, `SyncDirection`, the two `FolderMapping` fields, `vaultId` on `PluginData`; remove `baseline`; update `DEFAULT_DATA` and the ABOUTME lines.
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit** — `feat: add two-way sync data types, drop baseline`.

---

### Task 2: Exclude `.vaultsync/` from mapping resolution

**Files:**
- Modify: `src/PathResolver.ts`
- Test: `src/PathResolver.test.ts` (extend)

**Interfaces:**
- Produces: `resolveMapping` returns `null` for any path containing a `.vaultsync/` segment; `destAbsolutePath` unchanged. New exported const `SYNC_DIR = '.vaultsync'`.

- [ ] **Step 1: Write the failing test** — a file at `Knowledge/.vaultsync/<id>.ndjson` under an active `Knowledge` mapping resolves to `null`; a normal file still resolves.

```ts
test('paths inside .vaultsync are not managed', () => {
  const m = [{ sourcePath: 'Knowledge', destPath: 'Knowledge', active: true, direction: 'two-way' }];
  expect(resolveMapping('Knowledge/.vaultsync/abc.ndjson', m)).toBeNull();
  expect(resolveMapping('Knowledge/note.md', m)).not.toBeNull();
});
```

- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement** — add `SYNC_DIR`; in `resolveMapping`, return `null` when the path has a `.vaultsync` segment (`sourcePath.split('/').includes(SYNC_DIR)`).
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit** — `fix: never treat .vaultsync as syncable content`.

---

### Task 3: OpLogCodec (pure NDJSON)

**Files:**
- Create: `src/OpLogCodec.ts`
- Test: `src/OpLogCodec.test.ts` (new)

**Interfaces:**
- Consumes: `LogEntry` (Task 1).
- Produces:
  - `parse(text: string): LogEntry[]` — one entry per valid line; a trailing unparseable/partial line is skipped silently; blank lines ignored.
  - `serializeLine(entry: LogEntry): string` — compact JSON + `\n`.
  - `lastSyncedByPath(entries: LogEntry[]): Map<string, string | null>` — latest entry per path; `null` means the latest op is a `delete` (path currently absent).
  - `compact(entries: LogEntry[]): LogEntry[]` — one `update` entry per path whose latest op is not `delete`, at that path's latest md5; delete and superseded history dropped; order by ts.

- [ ] **Step 1: Write failing tests** — round-trip `parse(serializeLine(e)) == [e]`; a torn final line (`'{"ts":1,...}\n{"ts":2'`) yields one entry; `lastSyncedByPath` returns latest md5 and `null` after a delete; `compact` drops deletes and keeps one line per live path.

```ts
test('parse skips a torn trailing line', () => {
  const good = serializeLine({ ts: 1, op: 'create', path: 'a.md', md5: 'x' });
  expect(parse(good + '{"ts":2,"op":"up')).toHaveLength(1);
});
test('compact keeps one line per live file, drops deletes', () => {
  const e = [
    { ts: 1, op: 'create', path: 'a.md', md5: 'x' },
    { ts: 2, op: 'update', path: 'a.md', md5: 'y' },
    { ts: 3, op: 'create', path: 'b.md', md5: 'z' },
    { ts: 4, op: 'delete', path: 'b.md', md5: 'z' },
  ];
  expect(compact(e)).toEqual([{ ts: 2, op: 'update', path: 'a.md', md5: 'y' }]);
});
```

- [ ] **Step 2: Run tests, verify they fail** — module missing.
- [ ] **Step 3: Implement `src/OpLogCodec.ts`** — `parse` wraps each line in `try/JSON.parse`, skips on throw or missing fields; others as specified.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat: add OpLogCodec NDJSON parse/serialize/compact`.

---

### Task 4: SyncEngine push reconcile

**Files:**
- Modify: `src/SyncEngine.ts`
- Test: `src/SyncEngine.test.ts` (rewrite the baseline-era cases)

**Interfaces:**
- Consumes: `WriterLike` (existing: `writeFile`, `readFileIfExists`, `trashFile`); `LogEntry`.
- Produces a new `LogAccess` injected dep and reworked `SyncDeps`:

```ts
interface LogAccess {
  lastSynced(mapping: FolderMapping, path: string): string | undefined; // latest md5, undefined if none
  loggedPaths(mapping: FolderMapping): string[];                        // paths whose latest op is not delete
  append(mapping: FolderMapping, entry: LogEntry): Promise<void>;
}
interface SyncDeps {
  readSource(sourcePath: string): Promise<Buffer>;
  isFile(sourcePath: string): boolean;
  writer: WriterLike;        // targets the peer vault
  log: LogAccess;
  store: SettingsStore;
  checksum(data: Buffer): string;
  notify(message: string): void;
  now(): number;             // injectable clock for ts + conflict-copy name
}
```

- `handleUpsert(sourcePath)` implements the push table from the spec: no-op when `myMd5 == lastSynced`; create when peer absent; converge (append only) when peer md5 == myMd5; overwrite when peer md5 == lastSynced; conflicting-copy when peer differs from both. Appends the matching `LogEntry` via `log.append`.
- `handleDelete(sourcePath)`: trash peer copy if present, append `{op:'delete'}`.
- `handleRename(oldPath, newPath)`: delete + upsert (unchanged shape).
- `reconcile(sourceFiles)`: upsert each; then for every path in `log.loggedPaths(mapping)` that is no longer in `sourceFiles` and still resolves to a mapping, `handleDelete`.
- Conflicting-copy name uses `now()`-derived colon-free ISO; if that path already exists in the peer, append a short counter suffix to stay unique.

- [ ] **Step 1: Write failing tests** with fake `WriterLike` + fake `LogAccess`, covering each Review-Focus and table row: unchanged → no write; absent peer → write + `create` logged; peer==mine → no write, `update` logged (echo-killer); peer==lastSynced → overwrite; peer differs from both → conflicting-copy written + notify; vanished source → trash + `delete` logged; two conflicts same `now()` → two distinct copy filenames.
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** the reworked engine; delete the old baseline-based branches.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat: push-based SyncEngine driven by op-log`.

---

### Task 5: SettingsStore — vaultId and mapping fields

**Files:**
- Modify: `src/SettingsStore.ts`
- Test: `src/SettingsStore.test.ts` (extend)

**Interfaces:**
- Consumes: `PluginData` (Task 1).
- Produces: `load()` mints `vaultId = crypto.randomUUID()` when empty and persists it; drop `getBaseline`/`setBaseline`/`removeBaseline`; add `getVaultId(): string`. A `mintId?: () => string` constructor param defaults to `crypto.randomUUID` so tests inject a deterministic id.

- [ ] **Step 1: Write failing test** — first `load()` on empty storage sets a non-empty `vaultId` and calls `save`; a second load keeps the same id; no `baseline` methods exist.
- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement** — inject `mintId`, mint-on-empty in `load`, remove baseline accessors, add `getVaultId`.
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit** — `feat: SettingsStore mints vaultId, drops baseline`.

---

### Task 6: LogIO (fs) and a LogAccess adapter

**Files:**
- Create: `src/LogIO.ts`
- Test: `src/LogIO.test.ts` (new, real `fs` in a tmp dir)

**Interfaces:**
- Consumes: `OpLogCodec` (Task 3), `destAbsolutePath`/`SYNC_DIR` (Task 2), `LogEntry`.
- Produces:
  - `class LogIO` constructed with `(peerVaultPath: string, myVaultId: string)`.
  - `logPathFor(mapping): string` → `<peerVaultPath>/<destPath>/.vaultsync/<myVaultId>.ndjson`.
  - `readEntries(mapping): Promise<LogEntry[]>` (empty if file/dir absent).
  - `append(mapping, entry): Promise<void>` (mkdir -p, append a serialized line).
  - `rewrite(mapping, entries): Promise<void>` (write temp `<file>.tmp`, then rename over; ignore a leftover tmp).
  - `scanForeignLogs(myVaultPath, mapping): Promise<string[]>` → foreign vault ids found under `<myVaultPath>/<sourcePath>/.vaultsync/` whose id ≠ `myVaultId`.
  - A `LogAccess` built over an in-memory cache of `readEntries` (via `OpLogCodec.lastSyncedByPath`) so `SyncEngine` can call `lastSynced`/`loggedPaths` synchronously; `append` writes through and updates the cache.

- [ ] **Step 1: Write failing tests** against a tmp dir — append then `readEntries` returns it; `rewrite` leaves exactly the given lines and renames atomically (a pre-planted `.tmp` is ignored by `readEntries`); `readEntries` on a missing path returns `[]`; `scanForeignLogs` lists other ids and skips our own.
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement `src/LogIO.ts`.**
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat: add LogIO for .vaultsync op-logs`.

---

### Task 7: setup.ts two-way bootstrap

**Files:**
- Modify: `src/setup.ts`
- Test: `src/setup.test.ts` (extend)

**Interfaces:**
- Consumes: existing `scanSetupConflicts`, `SetupDeps`.
- Produces: `bootstrapTwoWay(sourceFiles, mapping, peerVaultPath, deps): Promise<string[]>` — for pre-existing both-sides files that differ, returns the conflicting-copy dest paths to write (it does not move anything). One-way path (`scanSetupConflicts` + move-back) is untouched.

- [ ] **Step 1: Write failing test** — identical both-sides file → not reported; differing both-sides file → reported for conflicting-copy; source-only file → not reported.
- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement `bootstrapTwoWay`.**
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit** — `feat: two-way setup bootstrap via conflicting-copy`.

---

### Task 8: ConflictUI — propose, large-log, compaction notices

**Files:**
- Modify: `src/ConflictUI.ts`
- Test: covered by the manual checklist (Obsidian Modal/Notice glue, not unit-tested), consistent with the existing convention.

**Interfaces:**
- Produces: `proposeTwoWay(app, folder, foreignId): Promise<boolean>` (Enable two-way / Keep one-way, resolves `false` on dismiss); `noticeLargeLog(folder: string): void`; `noticeCompacted(folderCount: number): void`.

- [ ] **Step 1: Implement** the three wrappers, mirroring `confirmMoveBack`'s Modal pattern.
- [ ] **Step 2: Build check** — `npm run check` (tsc + build) passes.
- [ ] **Step 3: Commit** — `feat: add two-way proposal and log notices`.

---

### Task 9: Settings tab — direction toggle and Compact button

**Files:**
- Modify: `src/SettingsTab.ts`
- Test: manual checklist (UI glue).

**Interfaces:**
- Consumes: plugin methods from Task 10.
- Produces: per-folder dropdown/toggle bound to `mapping.direction`; a **Compact sync logs** button calling `plugin.compactLogs()`.

- [ ] **Step 1: Implement** the toggle + button in the existing folder list.
- [ ] **Step 2: Build check passes.**
- [ ] **Step 3: Commit** — `feat: settings direction toggle and compact button`.

---

### Task 10: main.ts wiring, discovery, compaction

**Files:**
- Modify: `src/main.ts`
- Test: manual checklist (plugin wiring); logic it calls is unit-tested in Tasks 3-7.

**Interfaces:**
- Consumes: `LogIO`/`LogAccess` (Task 6), reworked `SyncEngine` (Task 4), `SettingsStore` (Task 5), UI (Task 8), bootstrap (Task 7).
- Produces: `buildEngine()` injects `LogIO`-backed `LogAccess`, peer-targeted `VaultBWriter`, and `now: () => Date.now()`; `onLayoutReady` runs `reconcileAll()` then `runDiscovery()`; `runDiscovery()` uses `scanForeignLogs` and `proposeTwoWay`, honoring `dismissed`; `compactLogs()` reads each active mapping's log, `OpLogCodec.compact`, `LogIO.rewrite`, then `noticeCompacted`; a post-reconcile size check fires `noticeLargeLog` past a threshold constant.

- [ ] **Step 1: Implement** the wiring; route `addMapping` through `bootstrapTwoWay` when `direction === 'two-way'`, else today's move-back.
- [ ] **Step 2: Run `npm run check`** — tsc + build + full Vitest suite green.
- [ ] **Step 3: Update `docs/testing-checklist.md`** with the two-way manual E2E steps from the spec.
- [ ] **Step 4: Commit** — `feat: wire two-way sync, discovery, and compaction`.

---

### Task 11: Final verification

- [ ] **Step 1:** Run `npm run check`; confirm tsc, build, and all tests pass with zero new warnings.
- [ ] **Step 2:** Confirm `main.js` and `data.json` remain gitignored and untracked.
- [ ] **Step 3:** Re-read the spec's Review Focus list against the suite; confirm each line has a green test.
