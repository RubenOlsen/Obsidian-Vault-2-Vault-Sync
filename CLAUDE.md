# CLAUDE.md — Obsidian-Vault-2-Vault-Sync

Guidance for working in this repo. Read `gotchas.md` too; it holds the hard-won
details.

## What this is

An Obsidian desktop plugin that one-way syncs chosen folders from the vault it
runs in (source, "Vault A") into another vault on disk (destination, "Vault B").
Vault B runs nothing. Personal project, Go/TS tools are fine; this one is
TypeScript because Obsidian plugins are.

- Design (as-built): `docs/superpowers/specs/2026-11-10-vault-to-vault-sync-design.md`
- Plan (as-built): `docs/superpowers/plans/2026-11-10-vault-to-vault-sync.md`
- Manual test steps: `docs/testing-checklist.md`

## Architecture in one breath

Plugin watches source folders via the Obsidian Vault API, reads bytes, and
writes into Vault B through Node `fs` at an absolute path. Pure decision logic
(`SyncEngine`) is isolated from I/O behind injected collaborators, so it
unit-tests without a running Obsidian. `VaultBWriter` is the only unit that
touches Vault B's disk.

| File | Job |
|---|---|
| `src/main.ts` | Plugin entry: load settings, build engine, register vault events, route folder events to reconcile, run startup reconcile. Wiring only. |
| `src/SettingsStore.ts` | Owns `data.json` (dest path, mappings, baseline). Injected `load`/`save`. |
| `src/types.ts` | `FolderMapping`, `PluginData`, defaults. |
| `src/Checksum.ts` | `md5()` via Node `crypto` (change detection, not security). |
| `src/PathResolver.ts` | Pure: source path → owning mapping → absolute dest path. |
| `src/VaultBWriter.ts` | All `fs` access to Vault B: write (mkdir -p), read, trash. |
| `src/SyncEngine.ts` | The decision tree: upsert/delete/rename/reconcile, conflict handling. |
| `src/setup.ts` | Setup-time conflict scan + move-back-to-source. |
| `src/ConflictUI.ts` | Obsidian `Modal`/`Notice` wrappers. |
| `src/SettingsTab.ts` | Settings screen (Browse… dialog, source dropdown, compact folder list). |
| `src/folderDialog.ts` | Native folder picker, isolates `window.electron.remote`. |
| `styles.css` | Settings styling (Obsidian auto-loads it). |

## Commands

- `npm run check` — canonical check: `tsc --noEmit` + build + test. Run before claiming done.
- `npm test` — Vitest.
- `npm run build` — esbuild → `main.js` (gitignored; local artifact).
- `npm run link-vault` — symlink this repo into `../vaults/Vault A/.obsidian/plugins/vault-to-vault-sync` so Obsidian loads it live. Reload the plugin (toggle off/on, or Cmd+R) after a rebuild.

## Conventions

- TDD. Pure logic gets real unit tests; UI/Electron glue is covered by the
  manual checklist, not faked tests.
- No mocks of our own code; `SyncEngine` takes injected fakes for fs/source.
- Hand-written source files start with two `ABOUTME:` comment lines.
- Commit on a branch, merge to `main` explicitly. Conventional commits.
- `main.js` and `data.json` stay gitignored.

## Landmines (see gotchas.md for full list)

- Electron is reached only via `window.electron.remote` (NOT `require('electron')`
  or `require('@electron/remote')`, NOT dynamic `import()` — all fail in the CJS
  renderer). Dialog: `window.electron.remote.dialog.showOpenDialogSync(...)`.
  Trash: `window.electron.remote.shell.trashItem(path)`.
- Folder delete/rename arrive as one `TFolder` event; route to `reconcileAll()`,
  never the per-file path (it throws `EISDIR` on a directory).
- `reconcile` both pushes current files and trashes B copies whose source
  vanished (this is how offline deletes propagate).
- Dest trash honors `<VaultB>/.obsidian/app.json` `trashOption`
  (`system`/`local`/`none`, default `system`).
- When unsure of an Obsidian/Electron API, read a working installed plugin's
  bundled `main.js` under `<vault>/.obsidian/plugins/<id>/` instead of guessing.

## External references

- Obsidian developer docs (home): https://docs.obsidian.md/
- Build a plugin: https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin
- Sample plugin (project layout, esbuild): https://github.com/obsidianmd/obsidian-sample-plugin
- Obsidian TypeScript API — Vault (events, read/trash): https://docs.obsidian.md/Reference/TypeScript+API/Vault
- Obsidian TypeScript API index: https://docs.obsidian.md/Reference/TypeScript+API/
- Importer plugin (the folder-dialog reference, `window.electron.remote`): https://github.com/obsidianmd/obsidian-importer
- Manifest fields: https://docs.obsidian.md/Reference/Manifest
- Vault adapter / FileSystemAdapter: https://docs.obsidian.md/Reference/TypeScript+API/FileSystemAdapter
- Electron `shell.trashItem`: https://www.electronjs.org/docs/latest/api/shell#shelltrashitempath
- Electron `dialog.showOpenDialogSync`: https://www.electronjs.org/docs/latest/api/dialog#dialogshowopendialogsyncwindow-options
