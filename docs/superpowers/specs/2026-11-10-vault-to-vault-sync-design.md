# Vault-to-Vault Sync — Design Spec

Date: 2026-11-10
Status: Implemented (merged to main). This document reflects the as-built design.

## Purpose

An Obsidian plugin that one-way syncs one or more source folders from a
source vault (Vault A) into a destination vault (Vault B). The use case:
keep portable "trade knowledge" (CLI notes, clippings, technical how-tos)
flowing out of a restricted work vault into a private vault, without the
two vaults being coupled by a full bidirectional sync.

Scope for this version: one-way only. The user decides which vault is the
source. Two-way sync is explicitly out of scope (it would need an instance
running in each vault).

## Constraints and key architectural fact

An Obsidian plugin's Vault API can only reach files inside its own vault.
To write into a second vault the plugin must use Node `fs`/`path` with an
absolute path. Obsidian desktop runs on Electron, so Node APIs are
available. Therefore:

- The plugin runs **only in the source vault (Vault A)**.
- It reads and watches source folders via the Obsidian Vault API.
- It writes into Vault B via Node `fs` at a configured absolute path.
- Vault B runs nothing.

Stack follows the official `obsidian-sample-plugin`: TypeScript, esbuild,
`manifest.json` + `main.ts`. Source lives in this repo. A symlink from
`../vaults/Vault A/.obsidian/plugins/<plugin-id>` to this repo lets Vault A
load the plugin live during development.

## Behavior (agreed decisions)

- **Trigger:** live on change. Register `vault.on` for create, modify,
  delete, rename on the source folders, plus a reconcile pass on startup.
- **File scope:** all files, recursive — markdown, images, PDFs,
  attachments.
- **Folder mapping:** per-folder target path, defaulting to
  mirror-same-path. The user sets the destination vault absolute path once
  (via a native **Browse…** folder dialog, or by typing it); each added
  source folder is chosen from a dropdown of this vault's folders and shows
  its mirrored target pre-filled and editable.
- **Deletions:** full mirror. A source delete or rename propagates to B.
  Deleted files go to trash, honoring Vault B's own `trashOption` read from
  `<VaultB>/.obsidian/app.json` (system trash / local `.trash` /
  permanent). A deleted or renamed *folder* arrives as a single Obsidian
  `TFolder` event and is handled by a full reconcile (see Data flow), which
  also propagates deletes and renames made while the plugin was closed.
- **Delete-vs-edit:** a source delete **always** trashes B's copy, even if
  B's copy was edited since the last sync. Source is authoritative; the B
  copy is recoverable from trash.
- **Runtime conflict:** an MD5 baseline (Node `crypto`) is stored per
  managed file. Before overwriting B, the plugin checksums B's current
  file. If it differs from the baseline, B was edited: the incoming source
  version is written as a `conflicting-copy` and the user is notified; the
  baseline is advanced to the new source MD5 so the conflict does not fire
  repeatedly.
- **Setup-time conflict:** when a source folder is added and its B target
  already holds same-named, different-content files, the plugin informs the
  user and asks whether to move those B files back into the source vault,
  renamed with the prefix `From-Destination-Vault-`. Yes: move them A-side
  and confirm (they then sync back normally). No: the mapping is saved but
  left inactive until the user resolves it manually.

## Components

Each unit has one job and well-defined inputs so the risky logic tests
without a running Obsidian.

- **`main.ts` (plugin entry)** — `SyncPlugin extends Plugin`. `onload`
  loads settings, builds the services, registers vault event listeners and
  the settings tab, and runs a startup reconcile. `onunload` detaches
  listeners. Wiring only.
- **`SettingsStore`** — owns the `data.json` shape and
  `loadData`/`saveData`. Holds: destination vault absolute path, folder
  mappings (`{sourcePath, destPath, active}`), and the baseline manifest
  (`{relPath -> md5}` per mapping). Single source of truth for config and
  baseline.
- **`PathResolver`** — pure functions. Given a changed source file and the
  mappings, resolve the owning mapping and the absolute B path. No I/O.
- **`Checksum`** — `md5(buffer)` over Node `crypto`.
- **VaultBWriter** — all Node `fs` access to Vault B: write file
  (creating dirs), trash file (reads B's `trashOption` and routes to system
  trash / local `.trash` / permanent), and read B's current bytes for
  checksumming. Tolerates a directory path (returns no bytes rather than
  throwing). System trash goes through `window.electron.remote.shell`. The
  only unit that touches B's disk.
- **SyncEngine** — the decision logic. Takes a change event or reconcile
  request, uses `PathResolver` + `Checksum` + `SettingsStore` to decide the
  action, calls `VaultBWriter`, and updates the baseline. Refuses to write
  when no destination vault is configured. Collaborators are injected so the
  conflict rules are unit-testable without a real vault.
- **ConflictUI** — modals and notices: the setup-time "move B files back
  into A" prompt and runtime conflict/notice toasts. The engine returns a
  decision; the UI renders it.
- **SettingsTab** — the config screen: destination vault picker
  (Browse… + text field), a compact scrollable list of synced folders with
  per-row remove, and an add-folder row (source dropdown + editable
  destination). Styling lives in `styles.css`.
- **folderDialog** — isolates the native folder picker
  (`window.electron.remote.dialog.showOpenDialogSync`), so `SettingsTab`
  stays free of Electron; throws if the remote is absent and the caller
  falls back to manual entry.

## Data flow

**Startup reconcile.** Walk each active mapping's source folder, compare
every file's current MD5 to the baseline, and push anything new or changed
into B. Then trash B copies of any baseline entry under an active mapping
whose source file no longer exists — this propagates deletes and renames
made while the plugin was off. Same decision logic as live events, run in
bulk.

**Create / modify in a source folder.**
1. `PathResolver` finds the owning mapping and B path. Not in a mapping →
   ignore.
2. Read source bytes, compute MD5. Equals baseline → stop.
3. `VaultBWriter` reads B's current file (if any) and checksums it.
   - B absent, or B's MD5 equals baseline (untouched) → overwrite B, update
     baseline.
   - B's MD5 differs from baseline (B was edited) → write source version as
     `conflicting-copy`, notify, advance baseline to the new source MD5.

**Delete in a source folder.** Resolve owning mapping, `VaultBWriter`
trashes B's copy per B's `trashOption`, drop it from the baseline. Trash
always wins, even over a B edit.

**Rename in a source folder.** Obsidian supplies old + new path. Treat as
delete-old (trash B's old) + create-new; baseline updated for both.

**Delete or rename of a source *folder*.** Obsidian delivers one `TFolder`
event, not per-file. Routing a folder path through the per-file delete would
hit a directory and throw, so folder events trigger a full reconcile: it
re-syncs the current files and trashes B copies of baseline entries whose
source is gone. One mechanism covers folder deletes, folder renames, and
offline deletes.

**Adding a source folder in settings (setup-time conflict).** Compute the B
target. If it holds same-named, different-content files, run the
`ConflictUI` prompt. Yes → move those B files into the source vault
prefixed `From-Destination-Vault-` (they sync back normally). No → save the
mapping inactive. No clash → activate and run a reconcile for that folder.

## Testing

**Unit (bulk; no mocks of our own code).**
- `PathResolver`: owning-mapping resolution, mirror vs overridden target,
  files outside any mapping.
- `Checksum`: known bytes → known MD5.
- `SyncEngine`: the full decision tree via injected filesystem fakes with
  real logic — new file, unchanged file, source edit over untouched B,
  source edit over edited B (conflicting-copy), delete, rename, folder
  events ignored, reconcile purge of vanished sources, and no write when no
  destination is configured.

**Integration (real `fs`, temp dirs as vaults).**
- `VaultBWriter`: writes create dirs; trash routing for each `trashOption`
  against a temp B with a real `app.json`; checksum-read round-trips; a
  directory path returns no bytes instead of throwing.

**Manual end-to-end (documented checklist, the real two vaults).** Symlink
into Vault A; create, edit, delete, and rename files and folders in a source
folder; watch B; exercise the Browse… dialog, the source dropdown, and the
conflict prompts. Obsidian's events, the Electron dialog/trash, and the
settings UI are not driven headless; these stay human steps. Checklist:
`docs/testing-checklist.md`.

**Runner.** Vitest (TS-native, no Obsidian runtime needed). Canonical
check: `npm run check` = `tsc --noEmit` + `npm run build` + `npm test`.

## Resolved during implementation

- Obsidian Vault event callbacks pass `TAbstractFile` (rename also passes
  `oldPath: string`); folder events arrive as `TFolder`.
- `<VaultB>/.obsidian/app.json` `trashOption` is one of `system` / `local` /
  `none`; a missing file or key defaults to `system`.
- Electron is reached via `window.electron.remote` (not a `require`-able
  module): `…remote.dialog.showOpenDialogSync({properties:['openDirectory']})`
  for the folder picker and `…remote.shell.trashItem(path)` for system trash.
  Confirmed against Obsidian's own Importer plugin.
- Plugin id is `vault-to-vault-sync`; `isDesktopOnly: true`. Dev symlink via
  `npm run link-vault`.

## Out of scope

- Two-way / bidirectional sync.
- Syncing attachments referenced by a note but living outside the synced
  folder (e.g. a central Attachments folder) — such embeds may break in B.
- Live sync while Obsidian is closed. Deletes and renames made while closed
  are reconciled on next startup, but nothing syncs in real time without the
  source vault open.
- Path-traversal validation on an overridden destination folder (`../`); the
  user controls their own config.
