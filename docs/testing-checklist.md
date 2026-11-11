# Manual end-to-end testing checklist

Obsidian's event system and Electron trash are not driven headless, so these
steps are run by hand against the real Vault A (source) and Vault B
(destination). Run them after `npm run check` passes.

## Setup

- [ ] `npm run build` then `npm run link-vault` (symlinks the repo into
      `vaults/Vault A/.obsidian/plugins/vault-to-vault-sync`).
- [ ] Open Vault A in Obsidian, enable the "Vault-to-Vault Sync" community
      plugin (Settings → Community plugins).
- [ ] In the plugin settings, set **Destination vault path** to the absolute
      path of Vault B. Use the **Browse…** button (native folder dialog) or
      type it. If Browse shows "picker unavailable", type the path instead.

## Folder pickers

- [ ] **Browse…** next to the destination path opens a native OS folder
      dialog; choosing Vault B fills the field and saves it.
- [ ] The **Source folder** control is a dropdown listing this vault's
      folders; selecting one fills the **Destination folder** field to match.
- [ ] Editing the **Destination folder** field after selecting a source then
      picking a different source does not overwrite your manual edit.

## Add a folder (no conflict)

- [ ] Create a folder `Knowledge` in Vault A with a note `cli.md`.
- [ ] In settings, add source folder `Knowledge` (destination pre-fills to
      `Knowledge`). Click **Add folder**.
- [ ] Confirm `Knowledge/cli.md` appears in Vault B with identical content.

## Create / modify

- [ ] Add `Knowledge/clip.md` in Vault A → appears in Vault B.
- [ ] Add an image `Knowledge/pic.png` in Vault A → appears in Vault B and
      opens correctly (binary intact).
- [ ] Edit `Knowledge/cli.md` in Vault A → Vault B copy updates.

## Delete / rename

- [ ] Delete `Knowledge/clip.md` in Vault A → Vault B copy goes to trash,
      per Vault B's `trashOption` (check `.trash/` for `local`, OS trash for
      `system`).
- [ ] Rename `Knowledge/cli.md` to `Knowledge/cli-notes.md` in Vault A →
      old name trashed in Vault B, new name present.
- [ ] Delete a synced subfolder `Knowledge/cli` in Vault A → its files are
      trashed in Vault B (no error in the console).
- [ ] Rename a synced subfolder `Knowledge/cli` to `Knowledge/shell` in
      Vault A → files appear under the new name in Vault B, old ones trashed.

## Offline source deletes

- [ ] With Obsidian closed, delete a synced note from Vault A on disk.
      Reopen Vault A → on startup the Vault B copy is trashed (reconcile
      propagates deletes seen only after the fact).

## Conflict (B edited)

- [ ] Edit the Vault B copy of a synced note directly, then edit the Vault A
      source of the same note.
- [ ] Confirm Vault B keeps its edited file and a
      `… (conflicting-copy).md` appears with the source content, plus a
      notice in Vault A.

## Setup-time conflict (move back)

- [ ] Put a file in Vault B at a path a new mapping would target, with
      different content from a same-named Vault A file.
- [ ] Add that source folder. Confirm the prompt appears; choose **Yes** and
      verify the Vault B file moves into Vault A prefixed
      `From-Destination-Vault-`.
- [ ] Repeat, choose **No**, and verify the folder is listed inactive and no
      sync happens for it.

## Proactive discovery (two-way, fresh vault)

- [ ] With Vault A syncing a folder into Vault B (one-way), install the plugin in
      Vault B with no mappings configured. Reload Vault B.
- [ ] Verify Vault B proposes enabling two-way for that folder, naming Vault A by
      its vault name (from the `.vaultsync/<id>.meta.json` sidecar).
- [ ] Choose **Enable two-way**: verify a mapping is created in Vault B pointing
      back at Vault A (destination path auto-filled), and edits in Vault B now
      reach Vault A.
- [ ] Reload again and choose **Keep one-way** instead: verify the proposal does
      not reappear on subsequent reloads (dismissed).
