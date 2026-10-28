/**
 * Live probe for Plaud 4.0 support. Read-only: reads the stored Plaud
 * connection, then walks list -> metadata -> audio -> transcript/summary and
 * prints one PASS/FAIL/SKIP line per step. Never prints tokens, recording
 * names, emails or presigned URLs (hosts and sizes only).
 *
 * Runs under bun with the app's own env (DATABASE_URL, ENCRYPTION_KEY):
 *   docker cp scripts/plaud-v4-probe.ts <container>:/tmp/plaud-v4-probe.ts
 *   docker exec <container> bun /tmp/plaud-v4-probe.ts
 *
 * Optional env: PROBE_USER_EMAIL (pick the Riffado user), PROBE_LIMIT
 * (recordings to inspect, default 2), PROBE_DOWNLOAD=0 (skip audio bytes).
 */
import { createDecipheriv } from "node:crypto";
import { SQL } from "bun";

type Result = "PASS" | "FAIL" | "SKIP" | "INFO";
let failures = 0;

function log(step: string, result: Result, detail = ""): void {
    if (result === "FAIL") failures++;
    console.log(`[probe] ${result.padEnd(4)} ${step}${detail ? ` - ${detail}` : ""}`);
}

function decrypt(ciphertext: string, keyHex: string): string {
    const [ivHex, tagHex, dataHex] = ciphertext.split(":");
    const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(keyHex, "hex"),
        Buffer.from(ivHex, "hex"),
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
        decipher.update(Buffer.from(dataHex, "hex")),
        decipher.final(),
    ]).toString("utf8");
}

function host(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return "<invalid>";
    }
}

function sniff(buf: Uint8Array): string {
    const head = Buffer.from(buf.subarray(0, 12));
    if (head.subarray(0, 4).toString() === "OggS") return "ogg";
    if (head.subarray(0, 3).toString() === "ID3") return "mp3";
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return "mp3";
    if (head.subarray(4, 8).toString() === "ftyp") return "mp4";
    if (head.subarray(0, 4).toString() === "RIFF") return "wav";
    return `unknown(${head.subarray(0, 4).toString("hex")})`;
}

type Json = Record<string, unknown>;

async function main(): Promise<void> {
    const dbUrl = process.env.DATABASE_URL;
    const key = process.env.ENCRYPTION_KEY;
    if (!dbUrl || !key) {
        log("env", "FAIL", "DATABASE_URL and ENCRYPTION_KEY must be set");
        process.exit(2);
    }
    const limit = Number(process.env.PROBE_LIMIT ?? "2");
    const download = process.env.PROBE_DOWNLOAD !== "0";

    const sql = new SQL(dbUrl);
    const email = process.env.PROBE_USER_EMAIL;
    const rows = (email
        ? await sql`select c.bearer_token, c.api_base, c.workspace_id, c.plaud_email
                      from plaud_connections c join users u on u.id = c.user_id
                     where lower(u.email) = lower(${email}) limit 1`
        : await sql`select bearer_token, api_base, workspace_id, plaud_email
                      from plaud_connections order by updated_at desc limit 1`) as Json[];
    await sql.close();
    if (rows.length === 0) {
        log("connection", "FAIL", "no plaud_connections row");
        process.exit(1);
    }
    const conn = rows[0];
    const apiBase = String(conn.api_base || "https://api.plaud.ai");
    let ut: string;
    try {
        ut = decrypt(String(conn.bearer_token), key);
    } catch {
        log("connection", "FAIL", "could not decrypt stored token (wrong ENCRYPTION_KEY?)");
        process.exit(1);
    }
    log(
        "connection",
        "PASS",
        `api=${host(apiBase)} cachedWorkspace=${conn.workspace_id ? "yes" : "no"} storedEmail=${conn.plaud_email ? "yes" : "no"}`,
    );

    // Same browser-shaped headers the app sends (PLAUD_USER_AGENT from
    // src/lib/plaud/servers.ts, Origin/Referer from src/lib/plaud/fetch.ts);
    // without them Plaud answers 403. Standalone script, so inlined.
    const base = {
        Authorization: `Bearer ${ut}`,
        "Content-Type": "application/json",
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Origin: "https://web.plaud.ai",
        Referer: "https://web.plaud.ai/",
    };
    const get = async (path: string, headers: Record<string, string> = {}) => {
        const res = await fetch(`${apiBase}${path}`, { headers: { ...base, ...headers } });
        let body: Json = {};
        try {
            body = (await res.json()) as Json;
        } catch {}
        return { http: res.status, body };
    };

    // /user/me shape (the "Connected (email unknown)" label).
    const me = await get("/user/me");
    const meKeys = Object.keys(me.body).join(",");
    const meEmail =
        (me.body.data_user as Json | undefined)?.email ??
        (me.body.data as Json | undefined)?.email ??
        me.body.email;
    log("user/me", meEmail ? "PASS" : "INFO", `http=${me.http} keys=[${meKeys}] email=${meEmail ? "present" : "absent"}`);

    // 3.0 list: expect -1800907 on a migrated account.
    const v3 = await get("/file/simple/web?skip=0&limit=1&is_trash=0&sort_by=edit_time&is_desc=true");
    const migrated = v3.body.status === -1800907;
    log(
        "v3 list",
        "INFO",
        `http=${v3.http} status=${String(v3.body.status)} migrated=${migrated} items=${Array.isArray(v3.body.data_file_list) ? (v3.body.data_file_list as unknown[]).length : "n/a"}`,
    );

    // Workspace id.
    let ws = conn.workspace_id ? String(conn.workspace_id) : "";
    if (!ws) {
        const list = await get("/team-app/workspaces/list?need_personal_workspace=true");
        const workspaces = ((list.body.data as Json | undefined)?.workspaces ?? []) as Json[];
        const personal = workspaces.find((w) => w.workspace_type === "0") ?? workspaces[0];
        ws = personal ? String(personal.workspace_id) : "";
    }
    if (!ws) {
        log("workspace", "FAIL", "no workspace id");
        process.exit(1);
    }
    log("workspace", "PASS", `id=${ws.slice(0, 5)}...`);

    const v4h = {
        "x-scope-type": "workspace",
        "x-scope-id": ws,
        "app-platform": "web",
        "edit-from": "web",
        "app-language": "en",
    };

    const devices = await get("/device-app/device/list", v4h);
    log(
        "v4 devices",
        Array.isArray(devices.body.data_devices) ? "PASS" : "FAIL",
        `http=${devices.http} status=${String(devices.body.status)} count=${Array.isArray(devices.body.data_devices) ? (devices.body.data_devices as unknown[]).length : "n/a"}`,
    );

    // Step 1: list.
    const list = await get(`/file-app/v4/recordings/all?sort_by=updated&sort_order=desc&page_size=${Math.max(limit, 1)}`, v4h);
    const data = (list.body.data ?? {}) as Json;
    const items = (Array.isArray(data.items) ? data.items : []) as Json[];
    if (list.http !== 200 || !Array.isArray(data.items)) {
        log("1 list", "FAIL", `http=${list.http} status=${String(list.body.status)}`);
        process.exit(1);
    }
    const first = items[0] ?? {};
    log(
        "1 list",
        "PASS",
        `items=${items.length} nextCursor=${data.next_cursor ? "yes" : "no"} itemKeys=[${Object.keys(first).join(",")}]`,
    );

    for (const item of items.slice(0, limit)) {
        const id = String(item.file_id ?? "");
        const tag = `file ${id.slice(0, 6)}...`;
        log(
            `2 metadata ${tag}`,
            id && typeof item.version_ms === "number" ? "PASS" : "FAIL",
            `duration_ms=${String(item.duration_ms)} created=${typeof item.created_at_show_ms === "number" ? "yes" : "no"} version_ms=${typeof item.version_ms === "number" ? "yes" : "no"}`,
        );
        if (!id) continue;

        const detail = await get(`/file-app/v4/files/detail/${encodeURIComponent(id)}`, v4h);
        const objects = (((detail.body.data as Json | undefined)?.objects ?? []) as Json[]);
        const summary = objects
            .map((o) => `${String(o.object_type)}:${o.content_url ? "url" : "nourl"}`)
            .join(" ");
        log(`2 detail ${tag}`, detail.http === 200 ? "PASS" : "FAIL", `http=${detail.http} objects=[${summary}]`);

        // Step 3: audio.
        const meta = ((detail.body.data as Json | undefined)?.meta ?? {}) as Json;
        log(
            `2 meta ${tag}`,
            typeof meta.start_time === "number" ? "PASS" : "FAIL",
            `start_time=${typeof meta.start_time === "number" ? "yes" : "no"} duration=${String(meta.duration)} serial=${meta.serial_number ? "present" : "absent"} task_status=${String(meta.task_status)}`,
        );

        // Step 3: audio (4.0 has no temp-url endpoint; detail AUDIO only).
        const audioObj = objects.find((o) => o.object_type === "AUDIO");
        const audioUrl = audioObj?.content_url ? String(audioObj.content_url) : "";
        const route = "detail.AUDIO";
        if (!audioUrl) {
            log(`3 audio ${tag}`, "FAIL", `AUDIO object ${audioObj ? "has null content_url" : "missing"}`);
        }
        if (audioUrl) {
            if (!download) {
                log(`3 audio ${tag}`, "PASS", `route=${route} host=${host(audioUrl)} (download skipped)`);
            } else {
                const res = await fetch(audioUrl);
                const buf = new Uint8Array(await res.arrayBuffer());
                log(
                    `3 audio ${tag}`,
                    res.ok && buf.length > 0 ? "PASS" : "FAIL",
                    `route=${route} host=${host(audioUrl)} http=${res.status} bytes=${buf.length} format=${sniff(buf)}`,
                );
            }
        }

        // Step 4: transcript + summary.
        const pick = (types: string[]) =>
            types.map((t) => objects.find((o) => o.object_type === t && o.content_url)).find(Boolean);
        const tr = pick(["POLISHED_TRANSCRIPT", "TRANSCRIPT"]);
        if (!tr) {
            log(`4 transcript ${tag}`, "SKIP", "no transcript object with content_url (not transcribed on Plaud?)");
        } else {
            const res = await fetch(String(tr.content_url));
            const text = await res.text();
            let segments = -1;
            try {
                const parsed = JSON.parse(text);
                segments = Array.isArray(parsed) ? parsed.length : -1;
            } catch {}
            log(
                `4 transcript ${tag}`,
                !res.ok || segments < 0 ? "FAIL" : segments === 0 ? "INFO" : "PASS",
                `type=${String(tr.object_type)} http=${res.status} chars=${text.length} segments=${segments}`,
            );
        }
        const sm =
            objects.find((o) => o.object_type === "SUMMARY" && o.content_url) ??
            objects.find((o) => String(o.object_type).startsWith("SUMMARY_") && o.content_url);
        if (!sm) {
            log(`4 summary ${tag}`, "SKIP", "no summary object with content_url");
        } else {
            const res = await fetch(String(sm.content_url));
            const text = await res.text();
            log(`4 summary ${tag}`, res.ok && text.trim() ? "PASS" : "FAIL", `type=${String(sm.object_type)} http=${res.status} chars=${text.length}`);
        }
    }

    console.log(`[probe] done failures=${failures}`);
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
    const msg = (err instanceof Error ? err.message : String(err))
        .replace(/\?[^\s"')]*/g, "?<redacted>")
        .replace(/Bearer\s+\S+/gi, "Bearer <redacted>");
    console.log(`[probe] FAIL unexpected - ${msg}`);
    process.exit(1);
});
