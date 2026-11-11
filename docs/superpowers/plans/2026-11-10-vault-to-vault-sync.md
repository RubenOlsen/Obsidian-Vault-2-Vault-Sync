# Vault-to-Vault Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Obsidian plugin running in the source vault that one-way syncs configured folders into a destination vault on disk, with checksum-based conflict handling.

**Architecture:** The plugin runs only in the source vault. It watches configured folders via the Obsidian Vault API, reads file bytes, and writes into the destination vault through Node `fs` at an absolute path. Pure decision logic (`SyncEngine`) is isolated from I/O so it unit-tests without a running Obsidian; `VaultBWriter` is the only unit touching the destination disk.

**Tech Stack:** TypeScript, esbuild, Vitest, Obsidian plugin API, Node `fs`/`path`/`crypto`, Electron via `window.electron.remote` (folder dialog + system trash).

**Spec:** `docs/superpowers/specs/2026-11-10-vault-to-vault-sync-design.md`

**Status:** Complete and merged to main. Tasks 1–6 were built as planned; Tasks 7–8 (added below) capture the post-review fixes and the folder-picker/UI changes that followed. All 35 tests pass; canonical check is `npm run check` = `tsc --noEmit` + build + test.

## Global Constraints

- One-way sync only; the source vault runs the plugin, the destination runs nothing.
- Destination writes use Node `fs` at an absolute path, never the Obsidian Vault API.
- Checksums are MD5 via Node `crypto`; baseline manifest lives in the plugin's `data.json` in the source vault.
- All file I/O is binary (`Buffer`), so images/PDFs/attachments survive.
- Baseline key is the source-vault-relative path of each managed file.
- `conflicting-copy` naming: insert ` (conflicting-copy)` before the extension (`note.md` -> `note (conflicting-copy).md`).
- Setup-time move-back prefix is exactly `From-Destination-Vault-`.
- Destination trash honors `<destVault>/.obsidian/app.json` `trashOption`: `system` (`window.electron.remote.shell.trashItem`), `local` (move into `<destVault>/.trash/`), `none` (permanent `fs.rm`). Missing file or key defaults to `system`.
- Electron is reached only via `window.electron.remote` (never a `require`/`import` of `electron` or `@electron/remote`).
- Canonical check is `npm run check` = `tsc --noEmit` + `npm run build` + `npm test`.

## Review Focus

- **Binary files** (image/PDF attachments): read and written as `Buffer`, never decoded as text — tested in Task 4 and Task 5.
- **Missing intermediate directories** in the destination target path: writes `mkdir -p` first — tested in Task 4.
- **Destination app.json missing or `trashOption` absent**: trash falls back to `system` rather than throwing — tested in Task 4.
- **Folder (not file) events** from the vault: `handleUpsert` ignores non-files; folder delete/rename route to a full reconcile in `main.ts` (Task 7) — tested in Task 5/7.
- **Unchanged source re-save** (modify event where MD5 equals baseline): no write, no conflict — tested in Task 5.

---

### Task 1: Project scaffold

**Files:**
- Create: `manifest.json`, `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `vitest.config.ts`, `src/main.ts`, `scripts/link-into-vault.mjs`, `.gitignore`
- Test: `test/scaffold.test.ts`

**Interfaces:**
- Produces: a buildable plugin (`npm run build` -> `main.js`) and a working test runner (`npm test`). Plugin id `vault-to-vault-sync` (used for the symlink path `<VaultA>/.obsidian/plugins/vault-to-vault-sync`).

- [ ] **Step 1: Write a trivial failing test** in `test/scaffold.test.ts` asserting `import { version } from '../package.json'` is a non-empty string, to prove Vitest + TS + JSON imports work.
- [ ] **Step 2: Run `npm test`**, expect FAIL (no deps/config yet).
- [ ] **Step 3: Scaffold the project** from the `obsidian-sample-plugin` layout: `package.json` with scripts `build` (esbuild), `test` (vitest run), `check` (`npm run build && npm test`); devDeps `obsidian`, `esbuild`, `typescript`, `vitest`, `@types/node`. `manifest.json` with `id: "vault-to-vault-sync"`, `minAppVersion`, `isDesktopOnly: true` (Node `fs` + Electron required). `src/main.ts` with an empty `export default class extends Plugin {}`.
- [ ] **Step 4: Run `npm install` then `npm run check`**, expect build produces `main.js` and the test PASSES.
- [ ] **Step 5: Write `scripts/link-into-vault.mjs`** that symlinks the repo root into `../vaults/Vault A/.obsidian/plugins/vault-to-vault-sync` (creates the `plugins` dir if absent, removes a stale link first). Run it and confirm the link resolves.
- [ ] **Step 6: Commit.**

---

### Task 2: Data model, SettingsStore, Checksum

**Files:**
- Create: `src/types.ts`, `src/Checksum.ts`, `src/SettingsStore.ts`
- Test: `test/checksum.test.ts`, `test/settingsStore.test.ts`

**Interfaces:**
- Produces:
  - `FolderMapping { sourcePath: string; destPath: string; active: boolean }`
  - `PluginData { destVaultPath: string; mappings: FolderMapping[]; baseline: Record<string, string> }`
  - `md5(data: Buffer | string): string` (lowercase hex)
  - `SettingsStore` wrapping an injected `{ load(): Promise<PluginData|null>; save(d: PluginData): Promise<void> }` (Obsidian's `loadData`/`saveData` in prod, in-memory in tests). Methods: `get(): PluginData`, `load(): Promise<void>`, `persist(): Promise<void>`, `getBaseline(key): string | undefined`, `setBaseline(key, md5): void`, `removeBaseline(key): void`. `load()` applies defaults (`destVaultPath: ""`, `mappings: []`, `baseline: {}`) when storage is empty.

- [ ] **Step 1: Write failing tests.** `checksum.test.ts`: `md5(Buffer.from("abc"))` equals `"900150983cd24fb0d6963f7d28e17f72"`. `settingsStore.test.ts`: fresh store returns defaults after `load()` on empty storage; `setBaseline`/`getBaseline`/`removeBaseline` round-trip; `persist()` calls the injected save with the current data.
- [ ] **Step 2: Run tests**, expect FAIL (modules missing).
- [ ] **Step 3: Implement** `md5` via `crypto.createHash('md5')`, the types, and `SettingsStore` over the injected storage.
- [ ] **Step 4: Run tests**, expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 3: PathResolver

**Files:**
- Create: `src/PathResolver.ts`
- Test: `test/pathResolver.test.ts`

**Interfaces:**
- Consumes: `FolderMapping` (Task 2).
- Produces (pure functions, POSIX-style source paths in, absolute dest path out):
  - `resolveMapping(sourcePath: string, mappings: FolderMapping[]): FolderMapping | null` — the active mapping whose `sourcePath` is a path-prefix of `sourcePath`, else `null`.
  - `destAbsolutePath(sourcePath: string, mapping: FolderMapping, destVaultPath: string): string` — `path.join(destVaultPath, mapping.destPath, <sourcePath relative to mapping.sourcePath>)`.

- [ ] **Step 1: Write failing tests.** A file `Knowledge/cli/git.md` under mapping `{sourcePath:"Knowledge", destPath:"Knowledge"}` and `destVaultPath:"/B"` resolves and maps to `/B/Knowledge/cli/git.md`. An overridden `destPath:"Imported/Knowledge"` maps to `/B/Imported/Knowledge/cli/git.md`. A file outside any mapping resolves to `null`. An inactive mapping is not resolved. A sibling folder whose name shares a prefix (`KnowledgeBase/x.md` vs mapping `Knowledge`) does NOT match.
- [ ] **Step 2: Run tests**, expect FAIL.
- [ ] **Step 3: Implement** both functions. Guard the prefix check on a path boundary so `Knowledge` does not match `KnowledgeBase`.
- [ ] **Step 4: Run tests**, expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 4: VaultBWriter (integration, real fs)

**Files:**
- Create: `src/VaultBWriter.ts`
- Test: `test/vaultBWriter.test.ts` (uses `fs.mkdtemp` temp dirs as the destination vault)

**Interfaces:**
- Produces:
  - `new VaultBWriter(destVaultPath: string)`
  - `writeFile(destAbsPath: string, data: Buffer): Promise<void>` — `mkdir -p` the parent, then write.
  - `readFileIfExists(destAbsPath: string): Promise<Buffer | null>`
  - `trashFile(destAbsPath: string): Promise<void>` — reads `<destVaultPath>/.obsidian/app.json` `trashOption` and routes: `system` -> Electron `shell.trashItem`, `local` -> move into `<destVaultPath>/.trash/` (mkdir -p, overwrite), `none` -> `fs.rm`. Missing app.json/key -> `system`.
- Note: Electron `shell` access path is **verify-at-implementation**; isolate it behind a private `systemTrash(path)` method so the `local`/`none`/fallback branches test without Electron.

- [ ] **Step 1: Write failing tests** against a temp dest vault: `writeFile` into a non-existent nested path creates dirs and the file with exact bytes (use a non-UTF8 `Buffer` to prove binary safety); `readFileIfExists` returns bytes then `null` after removal; `trashFile` with `app.json {trashOption:"local"}` moves the file into `.trash/`; with `{trashOption:"none"}` removes it; with **no** app.json falls back to the system-trash branch (assert via a stubbed `systemTrash`).
- [ ] **Step 2: Run tests**, expect FAIL.
- [ ] **Step 3: Implement** `VaultBWriter` with `fs/promises`, parsing `app.json` defensively (missing file or key -> `system`).
- [ ] **Step 4: Run tests**, expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 5: SyncEngine (unit, injected collaborators)

**Files:**
- Create: `src/SyncEngine.ts`
- Test: `test/syncEngine.test.ts` (fakes for every collaborator)

**Interfaces:**
- Consumes: `PathResolver` (Task 3), `md5` (Task 2), `SettingsStore` (Task 2), `VaultBWriter` shape (Task 4).
- Produces: `new SyncEngine(deps)` where
  `deps = { readSource(sourcePath): Promise<Buffer>; isFile(sourcePath): boolean; writer: Pick<VaultBWriter,'writeFile'|'readFileIfExists'|'trashFile'>; store: SettingsStore; checksum: (b:Buffer)=>string; notify: (msg:string)=>void }`.
  Methods: `handleUpsert(sourcePath): Promise<void>`, `handleDelete(sourcePath): Promise<void>`, `handleRename(oldPath, newPath): Promise<void>`, `reconcile(sourceFiles: string[]): Promise<void>`.

- [ ] **Step 1: Write failing tests** covering the decision tree:
  - new file (no baseline, B absent) -> `writeFile` called, baseline set to source MD5.
  - unchanged modify (source MD5 == baseline) -> no `writeFile`, no `trashFile`.
  - source edit, B untouched (B MD5 == baseline) -> overwrite B, baseline advanced.
  - source edit, B edited (B MD5 != baseline) -> `writeFile` to the `note (conflicting-copy).md` path, `notify` called, baseline advanced to new source MD5.
  - delete -> `trashFile` on B path, baseline key removed (even when a fake reports B edited).
  - rename -> `trashFile` old B path + `writeFile` new B path, baseline keys updated.
  - `isFile` false (folder event) -> no-op.
  - binary bytes round-trip unchanged through upsert.
- [ ] **Step 2: Run tests**, expect FAIL.
- [ ] **Step 3: Implement** `SyncEngine`. `reconcile` runs `handleUpsert` for each given source file. Resolve mapping via `PathResolver`; unmapped paths are no-ops.
- [ ] **Step 4: Run tests**, expect PASS.
- [ ] **Step 5: Commit.**

---

### Task 6: ConflictUI, SettingsTab, and main wiring

**Files:**
- Create: `src/ConflictUI.ts`, `src/SettingsTab.ts`, `src/setup.ts`
- Modify: `src/main.ts`
- Test: `test/setup.test.ts`; manual E2E checklist in `docs/testing-checklist.md`
- Create: `docs/testing-checklist.md`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `scanSetupConflicts(sourceFiles, mapping, destVaultPath, deps): Promise<string[]>` in `src/setup.ts` — returns dest-side paths that exist with the same name but a different MD5 than their source counterpart.
  - `moveConflictsBackToSource(conflicts, deps): Promise<void>` — moves each dest file into the source vault folder, renamed with the `From-Destination-Vault-` prefix.
  - `main.ts`: `onload` loads settings, constructs `VaultBWriter` + `SyncEngine`, registers `vault.on('create'|'modify'|'delete'|'rename')` (callbacks typed per installed `obsidian` typings: `TAbstractFile`, rename also `oldPath: string`) routed to the engine, adds `SettingsTab`, runs a startup `reconcile`. `onunload` detaches via `this.registerEvent`.

- [ ] **Step 1: Write failing tests** for `src/setup.ts`: `scanSetupConflicts` flags a dest file with same name + different content, ignores same-content and dest-absent files; `moveConflictsBackToSource` renames with the exact prefix and places the file under the mapping's source folder (fakes for fs/source).
- [ ] **Step 2: Run tests**, expect FAIL.
- [ ] **Step 3: Implement** `setup.ts`, then `ConflictUI` (an Obsidian `Modal` for the move-back prompt + `Notice` toasts), `SettingsTab` (destination-vault path field; add/remove source folder; per-folder dest pre-filled to mirror and editable; activating a folder runs the setup-conflict flow then a reconcile), and wire `main.ts`.
- [ ] **Step 4: Run tests**, expect PASS. Run `npm run check`.
- [ ] **Step 5: Write `docs/testing-checklist.md`** — the manual E2E steps against the real Vault A/Vault B: link the plugin, set dest path, add a folder, then create/edit/delete/rename a file (markdown and an image) and verify B, including a conflicting-copy and a trashed file.
- [ ] **Step 6: Commit.**

---

### Task 7: Review-fix pass (post-merge)

Findings from the fresh whole-branch review, fixed with tests.

**Files:**
- Modify: `src/SyncEngine.ts`, `src/VaultBWriter.ts`, `src/main.ts`
- Test: `test/syncEngine.test.ts`, `test/vaultBWriter.test.ts`
- Docs: `docs/testing-checklist.md` (folder + offline-delete steps)

**Changes:**
- [x] Folder delete/rename events (`TFolder`) route to `reconcileAll()` in `main.ts` instead of the per-file path (which threw `EISDIR` on a directory).
- [x] `reconcile(sourceFiles)` now, after upserting, trashes B copies of any baseline entry under an active mapping whose source is gone — propagates offline deletes/renames and folder deletes. Test: "trashes B ... vanished while offline".
- [x] `SyncEngine` refuses to write/delete when `destVaultPath` is empty; `addMapping` guards the same. Test: "does not write when destVaultPath is empty".
- [x] `VaultBWriter.readFileIfExists` tolerates a directory path (swallows `EISDIR`). Test: "returns null for a directory path".
- [x] Deferred (not fixed): `trashOption` key-absent/malformed-JSON test gap; flat `.trash` basename collision (deliberate); destPath `../` traversal (user config).

### Task 8: Folder pickers and compact settings UI

Usability changes requested after first live use.

**Files:**
- Create: `src/folderDialog.ts`, `styles.css`, `src/electron.d.ts`
- Modify: `src/SettingsTab.ts`, `src/VaultBWriter.ts`, `esbuild.config.mjs`

**Changes:**
- [x] Destination vault path gains a **Browse…** button opening a native OS folder dialog via `window.electron.remote.dialog.showOpenDialogSync({properties:['openDirectory']})`; degrades to manual text entry if the remote is absent. (`src/folderDialog.ts`.)
- [x] Source folder is a dropdown of this vault's folders (`vault.getAllLoadedFiles()` filtered to `TFolder`); selecting one pre-fills the editable destination folder field.
- [x] Synced-folder list rendered as a compact, one-line-per-folder scrollable box (`styles.css`) so tens of folders don't push controls off-screen.
- [x] System trash switched from a (broken) `require('electron')` to `window.electron.remote.shell.trashItem`, matching Obsidian's own Importer plugin. Electron access is always `window.electron.remote`; `@electron/remote`/`electron` are no longer imported or externalized.

---

## Self-review notes

- **Spec coverage:** mechanism (Task 1/6), trigger + startup reconcile (Task 6/5/7), file scope recursive binary (Task 4/5), per-folder mapping with mirror default (Task 3/6/8), full-mirror deletes + rename incl. folders and offline (Task 5/7), trash honoring B's `trashOption` (Task 4/8), delete-always-wins (Task 5), MD5 baseline + conflicting-copy (Task 2/5), setup-time move-back (Task 6), folder pickers + compact UI (Task 8). All mapped.
- **Resolved (were verify-at-implementation):** Obsidian event callbacks pass `TAbstractFile` (rename `oldPath`), folders as `TFolder`; `trashOption` = `system`/`local`/`none`, default `system`; Electron via `window.electron.remote` for dialog and shell; plugin id `vault-to-vault-sync`.
