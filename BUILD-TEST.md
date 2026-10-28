# Plaud 4.0 support: build and live test

Test kit for `feat/plaud-4.0`. **Drop this file and `scripts/plaud-v4-probe.ts`
before opening the upstream PR** (PR text: `PR-plaud-4.0.md`).

## Branches

| Branch | Base | Use |
|---|---|---|
| `feat/plaud-4.0-v0.6.4` | tag `v0.6.4` | **Build the live-test image from this one.** Same feature commit, no DB migrations, so swapping the image back to 0.6.4 is safe. |
| `feat/plaud-4.0` | `origin/main` | Upstream PR branch. `main` carries migrations 0036-0038 that 0.6.4 does not have. |

## 1. Build (on the Unraid)

```sh
git clone --branch feat/plaud-4.0-v0.6.4 https://github.com/mattjcorner/riffado.git riffado-v4
cd riffado-v4
docker build -t riffado:0.6.4-v4 .
```

If the fork is not on GitHub yet, use the bundle instead of the clone:

```sh
git clone --branch feat/plaud-4.0-v0.6.4 riffado-plaud-4.0.bundle riffado-v4
```

## 2. Step probe (read-only, no app change)

`scripts/plaud-v4-probe.ts` reads the stored Plaud connection with the
container's own `DATABASE_URL` / `ENCRYPTION_KEY`, decrypts the token in
process, and logs one line per step. It never prints tokens, emails,
recording names or presigned URLs. Writes nothing. Plaud calls carry the
app's browser-style `User-Agent`, `Origin` and `Referer` (Plaud answers 403
without them).

```sh
docker cp scripts/plaud-v4-probe.ts riffado-app:/tmp/plaud-v4-probe.ts
docker exec -e PROBE_LIMIT=2 riffado-app bun /tmp/plaud-v4-probe.ts
docker exec riffado-app rm /tmp/plaud-v4-probe.ts
```

Optional env: `PROBE_USER_EMAIL=<riffado login>` when there is more than one
user, `PROBE_DOWNLOAD=0` to skip downloading audio bytes.

Expected on a migrated account:

```
[probe] PASS connection - api=api.plaud.ai cachedWorkspace=yes storedEmail=no
[probe] PASS user/me - http=200 keys=[status,data_user,...] email=present
[probe] INFO v3 list - http=200 status=-1800907 migrated=true items=n/a
[probe] PASS workspace - id=ws_xx...
[probe] PASS v4 devices - ...
[probe] PASS 1 list - items=2 ...
[probe] PASS 2 metadata file ...
[probe] PASS 2 detail file ... objects=[AUDIO:url TRANSCRIPT:url POLISHED_TRANSCRIPT:nourl SUMMARY:url]
[probe] PASS 2 meta file ... start_time=yes duration=... serial=present task_status=...
[probe] PASS 3 audio file ... route=detail.AUDIO ... format=ogg
[probe] PASS 4 transcript file ... segments=N      (INFO with segments=0 when Plaud's transcript is [])
[probe] PASS 4 summary file ...
```

4.0 has no temp-url endpoint (404), so audio comes only from the detail's
`AUDIO.content_url`. `AUDIO:nourl` plus a FAIL means Plaud has no
downloadable audio for that recording yet; the app retries it on every sync.
Report the full probe output (it is safe to paste).

## 3. End-to-end sync with the new image (cloned DB, live app untouched)

Runs the real sync code from the new image against a copy of the database
and scratch storage. `riffado-app` and its database are only read
(`pg_dump`).

```sh
# Names (no values) of the live app's network, DB container and env vars.
docker inspect riffado-app --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'
docker inspect riffado-app --format '{{range .Config.Env}}{{println .}}{{end}}' | cut -d= -f1
NET=<network from above>
PRODDB=<postgres container of riffado-app>
PGUSER=<db user>; PGDB=<db name>

# 3a. Clone the DB into a TEST postgres (match the live major version).
docker run -d --name riffado-v4-testdb --network "$NET" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=riffado postgres:16
sleep 5
docker exec "$PRODDB" pg_dump -U "$PGUSER" -Fc "$PGDB" \
  | docker exec -i riffado-v4-testdb pg_restore -U postgres -d riffado --no-owner --no-acl

# 3b. Switch off side effects in the CLONE only (no emails, Bark pushes,
#     webhooks, paid transcription, or title writes back to Plaud), and turn
#     on Plaud transcript/summary import so step 4 is exercised.
docker exec riffado-v4-testdb psql -U postgres -d riffado -c "
  UPDATE user_settings SET email_notifications=false, bark_notifications=false,
         auto_transcribe=false, sync_title_to_plaud=false, import_plaud_content=true;
  UPDATE webhook_endpoints SET enabled=false;
  UPDATE plaud_connections SET last_sync=NULL;"
# (main-based builds also have user_settings.auto_summarize; set it false too.)

# 3c. Env file for the test app: copy of the live env with DB, storage and
#     SMTP overridden. Contains secrets: chmod 600, never cat it.
umask 077
docker inspect riffado-app --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -vE '^(DATABASE_URL|DEFAULT_STORAGE_TYPE|LOCAL_STORAGE_PATH|SMTP_[A-Z_]*|BACKGROUND_SYNC_[A-Z_]*|S3_[A-Z_]*)=' \
  > /tmp/riffado-v4-test.env
cat >> /tmp/riffado-v4-test.env <<'EOF'
DATABASE_URL=postgres://postgres:test@riffado-v4-testdb:5432/riffado
DEFAULT_STORAGE_TYPE=local
LOCAL_STORAGE_PATH=/app/test-storage
BACKGROUND_SYNC_ENABLED=true
BACKGROUND_SYNC_INTERVAL_MS=60000
EOF
mkdir -p /tmp/riffado-v4-test-storage

# 3d. Run the new image as a TEST container (no published port needed).
docker run -d --name riffado-v4-test --network "$NET" \
  --env-file /tmp/riffado-v4-test.env \
  -v /tmp/riffado-v4-test-storage:/app/test-storage \
  riffado:0.6.4-v4

# 3e. Wait ~2 minutes for a background sync tick, then check.
docker logs riffado-v4-test 2>&1 | grep -E 'plaud|background-sync|Sync' | tail -40
```

Pass criteria, one per step:

| Step | Check | Pass |
|---|---|---|
| list | logs | `[plaud] account is on Plaud 4.0, using /file-app/v4 endpoints` and `[background-sync] synced=1 errors=0` |
| metadata | `SELECT plaud_file_id, duration, start_time, plaud_version, filesize, length(file_md5) FROM recordings ORDER BY updated_at DESC LIMIT 5;` | rows for the 4.0 recordings, sane duration and start time, filesize > 0, md5 length 32 |
| audio | `find /tmp/riffado-v4-test-storage -type f -exec ls -l {} +` and `head -c4` on one file | one file per recording, `OggS` (or ID3) |
| transcript | `SELECT r.plaud_file_id, t.source, length(t.text) FROM transcriptions t JOIN recordings r ON r.id=t.recording_id WHERE t.source='plaud';` | a row per recording Plaud has transcribed |
| summary | `SELECT recording_id, length(summary) FROM ai_enhancements;` | a row per recording Plaud has summarized |

(Run the SQL with `docker exec riffado-v4-testdb psql -U postgres -d riffado -c "..."`.)

A recording whose audio Plaud has not made available yet shows up in the
sync errors as `Plaud has no downloadable audio for this recording yet` and
is retried on every sync. That is expected for a fresh recording, not for an
old one.

Cleanup (TEST containers and scratch files only):

```sh
docker rm -f riffado-v4-test riffado-v4-testdb
rm -rf /tmp/riffado-v4-test-storage /tmp/riffado-v4-test.env
```

## 4. Going live (Matt's call, not part of this test)

Point `riffado-app` at `riffado:0.6.4-v4` in its existing Unraid template or
compose. Rollback: point it back at the previous image. The 0.6.4-based
branch adds no migrations.
