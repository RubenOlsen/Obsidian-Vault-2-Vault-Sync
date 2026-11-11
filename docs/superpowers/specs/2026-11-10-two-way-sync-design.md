# Two-Way Vault Sync — Design Spec

Date: 2026-11-10
Status: Proposed. Extends the shipped one-way plugin (see
`2026-11-10-vault-to-vault-sync-design.md`) with optional two-way sync.
Data flow is **push-based** (each vault pushes its own changes into the peer);
there is no pull/replay path, so there are no per-peer cursors and no
tombstone-retention problem.

## Purpose

Let a folder sync in both directions between two vaults, so an edit made in
either vault reaches the other, while keeping the existing one-way behavior
intact and default. The trigger: the user also edits notes in the
destination vault and wants those edits to flow back, not just out.

Two-way is opt-in per folder. One-way stays the default so nothing about the
current experience changes unless the user asks for it.

## Constraints and key architectural fact

Both vault folders live on the **same machine, same filesystem**. This is
the pivotal fact: a single running instance can read *and* write both vaults
through Node `fs`. Consequences:

- "Both Obsidian instances running at once" is **not** required for
  correctness. It only buys *live* propagation. One running instance can
  carry a change both ways on its next reconcile.
- The destination is made **self-describing**: each vault ships its change
  log into the peer vault, so a vault discovers an incoming sync by finding a
  foreign log in its own folder, even if its plugin is installed weeks later.

An Obsidian plugin's Vault API still only reaches its own vault; cross-vault
reads and writes use Node `fs` at absolute paths, exactly as the one-way
design established.

**Single operator.** One person drives both vaults with one keyboard and one
mouse, and can only type into one program at a time. Genuine simultaneous
edits of the *same* file in both vaults are therefore nearly impossible. The
"both advanced differently" conflict is a rare safety net (reachable mainly by
an external process writing a vault, or edits made on each side while offline),
not a hot path. So conflict handling stays deliberately cheap — a timestamped
copy — and the log needs no millisecond tie-breaking.

## Core model: a per-vault append-only op-log

Each vault owns one change log **per synced folder**, written into that
folder so it travels with the content:

```
<vault>/<MappedFolder>/.vaultsync/<origin-vault-id>.ndjson
```

- `.vaultsync/` is a dot-folder, so `vault.getFiles()` excludes it and it is
  never re-synced as content. (Verify at implementation; the one-way plugin
  already relies on `getFiles()` ignoring dot-folders.)
- One log file per origin vault, so a destination can take writes from
  several sources and always tell a foreign log from its own.

**Vault identity.** Each vault mints a stable `vaultId` once
(`crypto.randomUUID`) and stores it in its own `data.json`. The id stamps the
log filename.

**Log format: append-only NDJSON**, one JSON object per line:

```json
{"ts": 1731240000000, "op": "update", "path": "Projects/note.md", "md5": "ab12…"}
```

- `op` is one of `create`, `update`, `delete`.
- `path` is vault-relative.
- A `delete` carries the last known md5, no bytes.

NDJSON was chosen over CSV (filenames contain commas, which forces RFC-4180
quoting, and CSV extends poorly to a future `rename` op) and over SQLite
(native-addon ABI pain in Electron, or a WASM build that rewrites the whole
file anyway; the scale is a few thousand entries with a single writer per
log, so a database solves problems we do not have).

**Where a vault's own log lives.** A vault's log records what it has pushed
into the peer, so it lives *in the peer* alongside that pushed content:
`<peerVault>/<destPath>/.vaultsync/<my-id>.ndjson`. The running instance reads
its own log back from there to learn each path's **last-synced md5** (the
latest entry for that path). No cursor is needed: last-synced comes straight
from the log, and the peer's own pushes are observed as ordinary file changes.

The op-log is the **single** change-tracking mechanism. It replaces the
one-way `baseline` md5 map entirely; the latest log entry for a path is that
path's last-synced md5. No migration is provided — the plugin is not in
production use anywhere, so any stray `baseline` map in a local `data.json`
is simply ignored and the first reconcile rebuilds state from the files.

## Reconcile: push with conflict check

The engine only ever does one thing: **push this vault's current state into
the peer**, with a conflict check. Reconcile runs on startup
(`onLayoutReady`) and, when both instances run, is nudged by live file events.
Two-way is not a second code path — it is simply both vaults running this same
push against each other. The reverse direction is the peer's own push; this
instance observes it as a file change and converges.

For each file under a mapping's source folder, with `myMd5 = hash(my file)`
and `lastSynced = my log's latest md5 for that path`:

| Situation | Action |
|---|---|
| `myMd5 == lastSynced` | I have not changed it since the last push. Nothing. |
| Peer copy absent | Write my bytes; append `{create, path, myMd5}` to my log. |
| Peer md5 == `myMd5` | Already converged (e.g. the peer just pushed this to me). Append `{update, myMd5}` to record last-synced; write nothing. This is the echo-killer. |
| Peer md5 == `lastSynced` | Peer untouched since last sync. Overwrite: write my bytes; append `{update, myMd5}`. |
| Peer md5 differs from both | Peer changed it independently *and* I changed it. Write the incoming as a conflicting-copy into the peer; notify; append `{update, myMd5}` so it does not re-fire. |

**Deletes** are found the way the one-way reconcile already finds them: a path
that has a log entry but no longer exists in my vault. Pushing a delete trashes
the peer's copy (honoring the peer's `trashOption` from
`<peerVault>/.obsidian/app.json`, as today) and appends `{delete, path, lastMd5}`.

The conflicting-copy filename carries a **colon-free** timestamp so it is
valid on every filesystem, e.g. `note (conflicting-copy 2026-11-10T14-03-22).md`.

Pure one-way is the same engine; the peer simply never runs a reciprocal
mapping, so nothing is ever pushed back. The only one-way-specific behavior
retained from today: a one-way source delete trashes the peer copy
unconditionally (recoverable from trash), since the source is authoritative.

## Compaction

Because a delete is applied to the peer's disk the moment it happens (same
machine, `fs` reaches the peer whether or not its Obsidian is open), there is
**no tombstone-resurrection risk** and therefore no retention floor to respect.
Compaction is purely housekeeping against unbounded log growth:

- **Manual**, a **"Compact sync logs"** button in settings. Scale never forces
  it; the button rewrites each log to a current-state snapshot — one entry per
  currently-synced file at its last-synced md5 — and drops the superseded and
  already-applied delete history.
- Compaction writes a temp file and renames it over the old log, so a crash
  mid-compaction cannot corrupt it; a leftover temp file is ignored.
- **Large-log notice.** When a folder's log crosses a threshold (a few thousand
  lines), the plugin shows a notice suggesting compaction for that folder. It
  never compacts on its own.

## Discovery and consent

When a vault starts and finds a **foreign** `.vaultsync/<id>.ndjson` in a
folder that is not yet set up as two-way, it **proposes**, it does not act:

- A notice/modal: *"Folder 'X' receives a one-way sync from vault `<id>`.
  Enable two-way so your edits here sync back?"* with **Enable two-way** and
  **Keep one-way**.
- A per-folder `dismissed` flag stops it nagging if the user declines.
- Two-way is **never** auto-enabled. One-way writes from the peer keep
  arriving regardless; the only thing consent governs is this vault writing
  *back* into the peer.

## The toggle and setup

- Per-mapping `direction: "one-way" | "two-way"`, default `one-way`, so
  existing behavior is unchanged.
- **Bootstrap** (adding a folder whose destination already holds same-named,
  different-content files): one-way keeps today's move-back-to-source flow
  untouched. Two-way instead treats both sides' existing files as initial
  state and resolves any divergence with the normal conflicting-copy rule.

## Components

New, pure, unit-testable (no Obsidian, no `fs`):

- **`OpLogCodec.ts`** — serialize/parse NDJSON, skip a torn trailing line,
  derive last-synced md5 per path from a log, and the compaction transform
  (given a log, return the current-state snapshot lines). String in, string out.

New I/O collaborator:

- **`LogIO.ts`** — appends to and rewrites *my* log in the peer
  (`<peerVault>/<destPath>/.vaultsync/<my-id>.ndjson`), reads it back for
  last-synced, and scans *my own* vault folders for **foreign** logs (for
  discovery). Sibling to `VaultBWriter`.

Changed:

- **`SyncEngine.ts`** — reconcile becomes push-with-conflict-check driven by
  the log (last-synced from the log, append on each push); stays I/O-free, same
  injected-collaborator pattern as today.
- **`types.ts`** — add `vaultId`, per-mapping `direction` and `dismissed`, and
  `LogEntry`. Drop `baseline`. (No `cursors`.)
- **`SettingsStore.ts`** — mint `vaultId` once on first load; own the new
  mapping fields; drop the `baseline` map and its accessors.
- **`VaultBWriter.ts`** — unchanged in shape. The running instance only ever
  writes into the peer (content, the conflicting-copy, and its own log via
  `LogIO`), so a single peer-targeted writer still suffices.
- **`SettingsTab.ts`** — per-folder direction toggle, a **Compact sync logs**
  button.
- **`ConflictUI.ts`** — the enable-two-way proposal modal, the large-log
  notice, a compaction-result notice.
- **`setup.ts`** — two-way bootstrap path (conflicting-copy on pre-existing
  divergence); one-way move-back left intact.
- **`main.ts`** — wire `LogIO`, run discovery-and-propose on startup, route
  the compaction button.

## Testing

Pure unit tests (Vitest, no Obsidian), the bulk of coverage:

- **`OpLogCodec`**: serialize/parse round-trip; skip a torn trailing line;
  last-synced derivation (latest entry per path, delete → absent); compaction
  produces one snapshot entry per live file and drops superseded/delete history.
- **`SyncEngine` push reconcile** with injected fakes: unchanged file is a
  no-op; absent peer → create; peer-equals-mine → converge, no write
  (echo-killer); peer-equals-last-synced → overwrite; peer differs from both →
  conflicting-copy; a vanished source path → delete/trash; each push appends the
  right log entry.

Integration with temp dirs (real `fs`):

- **`LogIO`** append / read-back / compact against a tmp `.vaultsync/`,
  including temp-file-then-rename surviving a simulated crash (a leftover
  partial temp file is ignored); foreign-log discovery scan finds a log whose
  id is not ours and skips our own.

Manual E2E (added to `docs/testing-checklist.md`, since Electron/Obsidian are
not driven headless, matching the existing convention):

- two instances live round-trip; offline catch-up on next start; weeks-later
  discovery fires the propose modal; conflict yields a timestamped copy;
  delete propagates to trash; the compaction button; the large-log notice.

TDD throughout: pure logic red-green first, then wire the I/O.

## Out of scope

- Vaults on different machines (no shared filesystem). The whole self-
  describing-log model assumes `fs` reaches both.
- A diff/merge viewer. Conflicts produce timestamped copies; comparison is
  left to the user or an existing Obsidian plugin.
- Automatic compaction.
