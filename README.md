# Vault-to-Vault Sync

An Obsidian desktop plugin that syncs selected folders between two vaults on the
same machine, one-way or two-way, without a cloud service.

Each vault pushes its own changes into the other and keeps a small per-folder log
so edits made while the other vault was closed still propagate. When the same file
is changed on both sides, the incoming version is written as a timestamped
`conflicting-copy` instead of overwriting your work.

## Use case

The plugin author became fed up with maintaining the same information manually in two
vaults and rsync outside the Obsidian program becomes very hackish very fast. 

The main use case is when you have two vaults: One for work use and one private use
and there are some information that you want to have in both vaults. Example of this
kind of information is pure knowledge like unix commands, links to public articles,
copies of said articles into a vault, general development information, generalized
Splunk SPLs, Jira JQLs, Azure KQLs, SpringBoot interview questions used to vet 
prospective consultants, and so on.

This kind of information is seldom under NDA. However, most companies will not allow 
their employees to sync a work related vault to their non work machines, but they 
also cannot deny employees to take pure knowledge out of the workplace as long as the 
knowlege is not under NDA or other legal agreements.


## Requirements

- Obsidian desktop (the plugin is marked `isDesktopOnly`; it uses Node file APIs).
- Both vaults live on the **same machine / filesystem**. The plugin reaches the
  other vault by absolute path, so it does not work across devices on its own.
- For two-way sync, install and enable the plugin in **both** vaults. One running
  instance is enough for correctness; running both just makes propagation live.

## Manual installation

Fetch the plugin from https://github.com/RubenOlsen/Obsidian-Vault-2-Vault-Sync/releases
plugins list.

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest
   [release](../../releases).
2. Copy them into `<your-vault>/.obsidian/plugins/vault-to-vault-sync/`.
3. In Obsidian: Settings -> Community plugins -> enable **Vault-to-Vault Sync**.

Repeat for the second vault if you want two-way sync. Each vault keeps its own
`data.json`, so do not share a plugin folder between vaults (a symlink would make
them share settings and identity).

## Setup

In the plugin settings:

1. Set the **Destination vault path** to the other vault's folder (use Browse or
   type the absolute path).
2. Under **Add a folder**, pick a source folder, confirm the destination folder
   (defaults to mirror the source), choose **Sync direction** (`one-way` or
   `two-way`), and click **Add folder**.

For two-way, the simplest path is to set a folder up as two-way in vault A. Vault
A drops a small marker into vault B. Now install the plugin in vault B, and the 
next time vault B is open it offers to enable the matching two-way sync automatically.
On installation and enabling the plugin the two-way synch should also be automatically
available.

## How it works

- **Push with conflict check.** When you edit a file, the plugin writes it into the
  other vault only if the other copy is unchanged since the last sync. If both
  sides changed the file independently, it writes a
  `name (conflicting-copy <timestamp>).ext` and leaves both versions intact.
- **Deletes.** Deleting a file removes the other copy to trash, honoring the
  destination vault's trash setting (system trash, local `.trash`, or permanent)
  from its `.obsidian/app.json`.
- **Sync log.** Each synced folder carries a hidden `.vaultsync/` directory with an
  append-only log (and, for two-way discovery, a small `.meta.json` marker). These
  are ignored by Obsidian and never synced as note content. They are safe to leave
  in place; deleting them only resets "last synced" memory.
- **Compaction.** The log grows as you edit. **Settings -> Maintenance -> Compact
  sync logs** rewrites each log down to current state. The plugin also notices when
  a log gets large and suggests compacting.

## Conflicts at setup

When you add a folder whose destination already holds same-named but different
files, one-way setup offers to move those files back into the source first (so the
source is the single source of truth). Two-way setup instead resolves any
divergence with the normal conflicting-copy rule on the next sync.

## Limitations

- One peer at a time. The destination vault path is a single setting, so a vault
  syncs with one other vault.
- Desktop only, same machine. It does not replace Obsidian Sync or a cloud
  service for cross-device use.
- No merge/diff UI. Conflicts produce side-by-side copies for you to reconcile.

## Development

```bash
npm install
npm run check      # typecheck + build + tests
npm run build      # produce main.js
npm test           # vitest
npm run link-vault # symlink this repo into a local test vault's plugins folder
```

Pure logic (`SyncEngine`, `OpLogCodec`, `PathResolver`, `Discovery`) is unit
tested without a running Obsidian; filesystem glue (`LogIO`, `VaultBWriter`) is
tested against temp directories. UI and Electron glue are covered by
`docs/testing-checklist.md`.

## License

GNU General Public Licence, version 3.
