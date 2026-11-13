# Gotchas

Plain-text team-readable notes. One entry per fact.

## Plugin architecture: source vault only
An Obsidian plugin's Vault API only reaches files inside its own vault. To write into a second vault you must use Node `fs` with an absolute path (Obsidian desktop is Electron, so `fs` is available). The sync plugin therefore runs only in the source vault (Vault A), watches source folders via the Vault API, and writes into Vault B via `fs`. Vault B runs nothing.

## Trash behavior reads Vault B's config off disk
Deletes are mirrored to trash honoring Vault B's own `trashOption` in `<VaultB>/.obsidian/app.json` (system / local `.trash` / permanent), read directly from disk since the plugin does not run in B.

## Conflict detection uses an MD5 baseline manifest
Per managed file, store an MD5 (Node `crypto`) baseline in the plugin's `data.json` in Vault A. Before overwriting a file in B, checksum B's current copy; mismatch vs baseline means B was edited, so write the source version as a `conflicting-copy` and notify instead of clobbering. The baseline is what stops endless conflicting-copies.

## Source is authoritative
Full one-way mirror. Source delete/rename always propagates to B (to trash), even over a B-side edit. One-way only for now.

## Folder events route to a full reconcile
Obsidian delivers a folder delete/rename as a single `TFolder` event, not per-file. Passing a folder path to the per-file delete path would hit a directory and throw EISDIR. So `main.ts` routes any `TFolder` delete/rename to `reconcileAll()`. `reconcile` upserts current source files and then trashes B copies of any baseline entry whose source no longer exists. That one mechanism also propagates deletes/renames made while Obsidian was closed (startup reconcile).

## Electron access is via window.electron.remote
Obsidian desktop exposes the Electron remote proxy at `window.electron.remote`, not as a `require('@electron/remote')` module and not via dynamic `import('electron')` (both fail in the CJS renderer). Native folder dialog: `window.electron.remote.dialog.showOpenDialogSync({ properties: ['openDirectory'], defaultPath })` (sync, returns string[] or undefined). System trash: `window.electron.remote.shell.trashItem(path)`. Confirmed by grepping Obsidian's own Importer plugin `main.js`. When unsure of an Obsidian/Electron API, read a working installed plugin's bundled `main.js` instead of guessing.

## Two-way sync (push model, implemented 2026-11-10, branch design/two-way-sync)
Opt-in two-way sync behind a per-folder `direction` toggle (default one-way, existing behavior unchanged). Both vaults live on the SAME machine/filesystem, so one running instance `fs`-reaches both; "both Obsidian running" is not needed for correctness, only live propagation. Data flow is **push**: each vault pushes its own changes into the peer (bytes + conflict check against last-synced), recording what it pushed in an append-only NDJSON op-log (`{ts, op(create|update|delete), path, md5}`) shipped INTO the peer at `<peerVault>/<destPath>/.vaultsync/<myVaultId>.ndjson`. Two-way = both vaults running the same push at each other; md5-equality is the echo-killer (equal → log an update, no write). Last-synced md5 = latest log entry (op-log replaced the old baseline map). Conflict (peer differs from both mine and last-synced) → colon-free timestamped conflicting-copy with a counter suffix for same-second collisions; never overwrites a divergent peer file. Deletes apply to the peer disk immediately, so NO cursors/tombstones/resurrection risk; compaction is a manual "Compact sync logs" button + a large-log notice (>2000 lines), collapsing to a snapshot via temp-file-then-rename. Stable `vaultId` in `data.json` names each log; foreign logs make a destination self-describing (discover-and-propose two-way, never auto-enable — currently only flips EXISTING mappings). Chose NDJSON over CSV (comma-in-filenames) and SQLite (Electron native-addon pain, tiny scale, single writer). `.vaultsync/` is a dot-folder, excluded by `getFiles()` and by a `resolveMapping` segment guard. Modules: `OpLogCodec.ts` (pure), `LogIO.ts` (fs + `CachedLogAccess` — callers MUST `preload(mapping)` before the engine reads it; it degrades to undefined/[] rather than throwing), `SyncEngine.ts` (push + conflict), rest wired in `main.ts`. By-design caveat: a delete trashes the peer copy even over a concurrent peer edit (recoverable unless the peer's trashOption is `none`).

## SDD gotcha: commit controller edits before dispatching
During subagent-driven-development, an implementer subagent's git activity (commit/checkout/stash) can silently revert UNCOMMITTED working-tree edits the controller made. Commit or stash your own edits before dispatching an implementer; keep private memory as source of truth during a run and re-apply in-repo docs between tasks.

## Installing the plugin in a second vault (two-way)
For two-way, BOTH vaults run the plugin, each needing its OWN `data.json` (own `vaultId`, mappings). The source vault here is symlinked in (`npm run link-vault` → `../vaults/Vault A/.obsidian/plugins/vault-to-vault-sync` → repo), which auto-updates on rebuild. The second vault must get the plugin COPIED in (real `manifest.json`+`main.js`+`styles.css` under `<VaultB>/.obsidian/plugins/vault-to-vault-sync/`), NOT symlinked — a symlink would make both vaults share one `data.json`. Enable it via `<VaultB>/.obsidian/community-plugins.json` = `["vault-to-vault-sync"]`. Gotcha: a copied install does NOT auto-update — every `npm run build` must be manually re-copied into the second vault; reload the plugin (toggle off/on or Cmd+R) after.

## Pushing to main

Personal repo. When asked to "commit and push", fast-forward main and push it; no PR needed. Branch for in-progress work if you like.
