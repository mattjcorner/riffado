import { createHash } from "node:crypto";
import type {
    PlaudContentItem,
    PlaudFileDetailResponse,
    PlaudRecording,
    PlaudV4DetailObject,
    PlaudV4FileDetail,
    PlaudV4FileMeta,
    PlaudV4RecordingItem,
} from "@/types/plaud";

/**
 * In-band status the 3.0 `/file/*` endpoints return for an account that Plaud
 * has migrated to the 4.0 platform ("Account migrated to 4.0. Please update
 * and reinitialize.").
 */
export const PLAUD_V4_MIGRATED_STATUS = -1800907;

/** Largest `page_size` sent to `/file-app/v4/recordings/all` (the web app's value). */
export const PLAUD_V4_MAX_PAGE_SIZE = 300;

export type PlaudPlatform = "v3" | "v4";

/** True when a 3.0 response body says the account now lives on 4.0. */
export function isV4MigratedBody(body: unknown): boolean {
    return (
        typeof body === "object" &&
        body !== null &&
        (body as { status?: unknown }).status === PLAUD_V4_MIGRATED_STATUS
    );
}

/** Headers every `/file-app/v4/*` call carries besides `Authorization`. */
export function v4ScopeHeaders(workspaceId: string): Record<string, string> {
    return {
        "x-scope-type": "workspace",
        "x-scope-id": workspaceId,
        "app-platform": "web",
        "edit-from": "web",
        "app-language": "en",
    };
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined;
}

/**
 * Map a 4.0 list item onto the 3.0 `PlaudRecording` shape the sync pipeline
 * consumes. Returns `undefined` for items without a `file_id`.
 *
 * 4.0 does not report transcript/summary availability in the list, so
 * `is_trans`/`is_summary` are both `true` and the content-import pass decides
 * from the detail response. `filesize`/`file_md5` are 0/"" when Plaud omits
 * them; the sync fills them from the downloaded audio.
 */
export function normalizeV4Recording(
    item: PlaudV4RecordingItem,
): PlaudRecording | undefined {
    const id = nonEmptyString(item.file_id);
    if (!id) return undefined;

    const duration = Math.max(0, finiteNumber(item.duration_ms) ?? 0);
    const start =
        finiteNumber(item.start_time_ms) ??
        finiteNumber(item.created_at_show_ms) ??
        finiteNumber(item.updated_at_show_ms) ??
        0;
    const version =
        finiteNumber(item.version_ms) ??
        finiteNumber(item.updated_at_show_ms) ??
        start;
    const filename = nonEmptyString(item.name) ?? id;

    return {
        id,
        filename,
        keywords: [],
        filesize:
            finiteNumber(item.file_size) ?? finiteNumber(item.filesize) ?? 0,
        filetype: "",
        fullname: filename,
        file_md5: nonEmptyString(item.file_md5) ?? "",
        ori_ready: true,
        version,
        version_ms: version,
        edit_time: finiteNumber(item.updated_at_show_ms) ?? version,
        edit_from: "web",
        is_trash: false,
        start_time: start,
        end_time: start + duration,
        duration,
        timezone: finiteNumber(item.timezone) ?? 0,
        zonemins: finiteNumber(item.zonemins) ?? 0,
        scene: finiteNumber(item.scene) ?? 0,
        filetag_id_list: [],
        serial_number:
            nonEmptyString(item.serial_number) ??
            nonEmptyString(item.device_sn) ??
            nonEmptyString(item.sn) ??
            "",
        is_trans: true,
        is_summary: true,
    };
}

function findObject(
    objects: PlaudV4DetailObject[],
    predicate: (type: string) => boolean,
): PlaudV4DetailObject | undefined {
    return objects.find(
        (o) =>
            typeof o?.object_type === "string" &&
            predicate(o.object_type) &&
            nonEmptyString(o.content_url) !== undefined,
    );
}

/** Presigned audio URL from a 4.0 detail, or `undefined` when Plaud has none yet. */
export function findV4AudioUrl(detail: PlaudV4FileDetail): string | undefined {
    const audio = findObject(detail.objects ?? [], (t) => t === "AUDIO");
    return nonEmptyString(audio?.content_url);
}

/**
 * Overlay a 4.0 detail `meta` on a list-derived recording: the device serial
 * (absent from the list), the real recording start (`meta.start_time`; the
 * list only has `created_at_show_ms`) and the duration when the list had none.
 */
export function applyV4Meta(
    recording: PlaudRecording,
    meta: PlaudV4FileMeta | undefined,
): PlaudRecording {
    if (!meta) return recording;
    const duration =
        recording.duration > 0
            ? recording.duration
            : Math.max(0, finiteNumber(meta.duration) ?? 0);
    const start = finiteNumber(meta.start_time) ?? recording.start_time;
    return {
        ...recording,
        serial_number:
            nonEmptyString(meta.serial_number) ?? recording.serial_number,
        duration,
        start_time: start,
        end_time: start + duration,
    };
}

/**
 * Adapt a 4.0 file detail to the 3.0 `content_list` shape so the existing
 * `selectContentItems` / `parseTranscript` / `parseSummary` path imports it
 * unchanged. Only objects that already carry a `content_url` are emitted, as
 * ready (`task_status: 1`) items. The polished transcript wins over the raw
 * one; the classic `SUMMARY` wins over `SUMMARY_*` variants.
 */
export function v4DetailToFileDetail(
    detail: PlaudV4FileDetail,
): PlaudFileDetailResponse {
    const objects = detail.objects ?? [];
    const content_list: PlaudContentItem[] = [];

    const transcript =
        findObject(objects, (t) => t === "POLISHED_TRANSCRIPT") ??
        findObject(objects, (t) => t === "TRANSCRIPT");
    if (transcript?.content_url) {
        content_list.push({
            data_id: `v4:${transcript.object_type}`,
            data_type: "transaction",
            task_status: 1,
            data_link: transcript.content_url,
        });
    }

    const summary =
        findObject(objects, (t) => t === "SUMMARY") ??
        findObject(objects, (t) => t.startsWith("SUMMARY_"));
    if (summary?.content_url) {
        content_list.push({
            data_id: `v4:${summary.object_type}`,
            data_type: "auto_sum_note",
            task_status: 1,
            data_link: summary.content_url,
        });
    }

    return {
        status: 0,
        data: {
            file_id: detail.meta?.file_id,
            file_name: detail.node?.name,
            duration: detail.meta?.duration,
            start_time: detail.meta?.start_time,
            content_list,
        },
    };
}

/** Hex MD5 of a buffer, used when Plaud 4.0 omits `file_md5`. */
export function md5Hex(buf: Buffer): string {
    return createHash("md5").update(buf).digest("hex");
}
