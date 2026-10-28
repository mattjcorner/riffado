<!-- DRAFT, not posted. Open only after the live end-to-end test passes.
     gh pr create -R riffado/riffado --base main --head mattjcorner:feat/plaud-4.0 \
       --title "feat(plaud): sync accounts migrated to Plaud 4.0" --body-file PR-plaud-4.0.md
     Drop BUILD-TEST.md, PR-plaud-4.0.md and scripts/plaud-v4-probe.ts from the branch first. -->

## What

Sync for Plaud accounts that Plaud has migrated to its 4.0 platform. Unmigrated accounts are unchanged.

## Why

For a migrated account every 3.0 endpoint answers with in-band status `-1800907`:

```json
{ "status": -1800907, "msg": "Account migrated to 4.0. Please update and reinitialize." }
```

`/file/simple/web` returns no `data_file_list`, so sync stops with a `TypeError` and the account never gets new recordings. The same account works against the 4.0 API (`/file-app/v4/*`).

## How

`PlaudClient` detects the platform for each account. Each public call runs the 3.0 request first. If that returns `-1800907`, either in-band or in an error body, the client switches to 4.0 for the rest of its life. Callers (`sync-recordings`, connect flow, title sync, dev info route) keep calling the same methods.

| | 3.0 | 4.0 |
|---|---|---|
| Auth | workspace token | user token plus `x-scope-type: workspace`, `x-scope-id: <ws_ id>`, `app-platform`/`edit-from: web` (the workspace token gets HTTP 400) |
| List | `/file/simple/web` (skip/limit) | `/file-app/v4/recordings/all` (`next_cursor`). The client remembers the cursor for each offset, so the sync loop still pages by `skip`. |
| Detail | `/file/detail/{id}` `content_list` | `/file-app/v4/files/detail/{id}` `objects[]`, adapted to `content_list` so the existing parsers import transcript and summary |
| Audio | `/file/temp-url/{id}` | presigned `content_url` of the `AUDIO` object, else 3.0 temp-url. If neither exists, the recording fails with a retryable message and is picked up on the next sync. |
| Devices | `/device/list` | `/device-app/device/list` (3.0 envelope) |
| Rename | `PATCH /file/{id}` | `PATCH /file-app/v4/nodes/rename/{node_id}` with `origin_version`, one retry on `-1800313` |

Other changes:

- 4.0 list items do not include transcript/summary flags, so `is_trans`/`is_summary` are reported true and the import pass decides from the detail. `filesize`/`file_md5` are filled from the downloaded audio when 4.0 leaves them out.
- A 3.0 list body without `data_file_list` now raises a typed `PLAUD_API_ERROR` with Plaud's `msg` instead of a `TypeError`.
- `/user/me` returns the email under `data_user`. Reading it from there fixes "Connected (email unknown)" for token and connector connections.

The endpoint shapes follow the 4.0 client in [ckelsoe/obsidian-plaud-importer](https://github.com/ckelsoe/obsidian-plaud-importer).

## Tests

- `src/tests/plaud-v4.test.ts`: list item mapping, detail adapter feeding `selectContentItems`/parsers, polished-transcript preference, audio URL lookup, 3.0 accounts never touching 4.0, switch on in-band and HTTP-error `-1800907`, user token and scope headers, cursor paging including walk-forward and end of list, trash, workspace discovery, negative in-band status mapping, audio from detail, temp-url fallback, audio-not-ready, device list fallback, node rename, `/user/me` `data_user`.
- `src/tests/sync/plaud-v4-sync.test.ts`: a normalized 4.0 recording syncs with duration, start time, version, and size/md5 taken from the audio.
- Full suite, `pnpm type-check` and `biome check` pass.
- Live: a migrated account on a self-hosted instance synced its recordings (list, metadata, audio, Plaud transcript/summary) with this branch. <!-- fill in after the live test -->

## Notes

- Platform detection is per client instance, so a migrated account spends one extra 3.0 call per sync to learn it is on 4.0. Storing the platform on `plaud_connections` would avoid that but needs a migration. I kept that out of this PR.
- With "import Plaud content" enabled, a 4.0 recording that has no Plaud transcript gets its detail fetched on every sync, because the 4.0 list cannot say whether one exists.
