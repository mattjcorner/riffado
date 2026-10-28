/**
 * Fictional Plaud 4.0 payloads with the field set observed live on
 * `/file-app/v4/recordings/all` and `/file-app/v4/files/detail/{id}`.
 */

export const V4_WORKSPACE_ID = "ws_000000000000";

export const V3_MIGRATED_BODY = {
    status: -1800907,
    msg: "Account migrated to 4.0. Please update and reinitialize.",
};

export function v4ListItem(overrides: Record<string, unknown> = {}) {
    return {
        file_id: "f1",
        name: "Weekly sync",
        duration_ms: 125000,
        created_at_show_ms: 1761000000000,
        updated_at_show_ms: 1761000500000,
        version_ms: 1761000500000,
        status: 0,
        file_task_status: 1,
        parent_folder: {
            folder_id: "fld1",
            name: "Recordings",
            system_folder_type: 1,
        },
        safe_scan: { status: 0 },
        ...overrides,
    };
}

export function v4ListBody(
    items: unknown[],
    nextCursor: string | null = null,
): unknown {
    return { status: 0, data: { items, next_cursor: nextCursor } };
}

export const V4_TRANSCRIPT_URL = "https://s3.example.com/transcript?sig=t";
export const V4_POLISHED_URL = "https://s3.example.com/polished?sig=p";
export const V4_SUMMARY_URL = "https://s3.example.com/summary?sig=s";
export const V4_AUDIO_URL = "https://s3.example.com/audio.ogg?sig=a";

export const V4_META = {
    file_id: "f1",
    duration: 125000,
    start_time: 1760999990000,
    timezone_iana: "America/Toronto",
    serial_number: "SN0000000001",
    scene_source: 1,
    task_status: 1,
    task_status_reason: null,
    version_ms: 1761000500000,
};

export const V4_DEFAULT_OBJECTS = [
    {
        object_type: "AUDIO",
        mime_type: "audio/ogg",
        content_url: V4_AUDIO_URL,
        object_size: 48213,
        version_ms: 1761000500000,
    },
    {
        object_type: "TRANSCRIPT",
        mime_type: "application/json",
        content_url: V4_TRANSCRIPT_URL,
        object_size: 512,
        version_ms: 1761000500000,
    },
    {
        object_type: "POLISHED_TRANSCRIPT",
        mime_type: "application/json",
        content_url: null,
        object_size: 0,
        version_ms: 1761000500000,
    },
    {
        object_type: "SUMMARY",
        mime_type: "text/markdown",
        content_url: V4_SUMMARY_URL,
        object_size: 64,
        version_ms: 1761000500000,
    },
];

export function v4DetailBody(objects: unknown[] = V4_DEFAULT_OBJECTS): unknown {
    return {
        status: 0,
        data: {
            node: {
                node_id: "n_sp_f1",
                version_ms: 1761000500000,
                name: "Weekly sync",
            },
            meta: V4_META,
            objects,
        },
    };
}

export const V4_TRANSCRIPT_BODY = [
    {
        segment_uid: "seg_0001",
        start_time: 0,
        end_time: 1500,
        content: "Hello everyone.",
    },
    {
        segment_uid: "seg_0002",
        start_time: 1500,
        end_time: 3000,
        content: "Second point.",
    },
];

export const V4_SUMMARY_BODY = "# Summary\n\n- First point\n- Second point\n";
