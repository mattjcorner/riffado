export interface PlaudDevice {
    sn: string;
    name: string;
    model: string;
    version_number: number;
}

export interface PlaudDeviceListResponse {
    status: number;
    msg: string;
    data_devices: PlaudDevice[];
}

export interface PlaudRecording {
    id: string;
    filename: string;
    keywords: string[];
    filesize: number;
    filetype: string;
    fullname: string;
    file_md5: string;
    ori_ready: boolean;
    version: number;
    version_ms: number;
    edit_time: number;
    edit_from: string;
    is_trash: boolean;
    start_time: number; // Unix timestamp in milliseconds
    end_time: number; // Unix timestamp in milliseconds
    duration: number; // Duration in milliseconds
    timezone: number;
    zonemins: number;
    scene: number;
    filetag_id_list: string[];
    serial_number: string;
    is_trans: boolean;
    is_summary: boolean;
}

export interface PlaudRecordingsResponse {
    status: number;
    msg: string;
    data_file_total: number;
    data_file_list: PlaudRecording[];
}

export interface PlaudTempUrlResponse {
    status: number;
    temp_url: string;
    temp_url_opus?: string;
}

export interface PlaudApiError {
    status: number;
    msg: string;
}

export interface PlaudWorkspace {
    workspace_id: string;
    member_id: string;
    name: string;
    role: string;
    status: string;
    workspace_type: string;
    region?: string;
    api_domain?: string;
    created_at?: string;
    creator_user_id?: string;
}

export interface PlaudWorkspaceListResponse {
    status: number;
    msg?: string;
    data: {
        workspaces: PlaudWorkspace[];
    };
    type?: string;
}

export interface PlaudWorkspaceTokenResponse {
    status: number;
    msg?: string;
    data: {
        status: number;
        workspace_token: string;
        expires_in: number;
        wt_expires_at: number;
        refresh_token: string;
        refresh_expires_in: number;
        refresh_expires_at: number;
        workspace_id: string;
        member_id: string;
        role: string;
    };
}

// --- Plaud-native content (transcript / summary / notes) — feature #204 ---
// Shape of GET /file/detail/{fileId}. Item selection + the summary/envelope
// shape are validated against a real captured response; the transcript segment
// body is still unverified. Kept permissive (all fields optional) so parsers
// defensively pick what they need.
export interface PlaudContentItem {
    // Stable-ish per-item id, e.g. 'source_transaction:<...>',
    // 'auto_sum:<...>', 'sum_multi:<...>'. Used for selection when the
    // free-text `data_type` strings drift.
    data_id?: string;
    data_type?: string; // 'transaction' | 'auto_sum_note' | 'sum_multi_note' | 'outline' | ...
    data_title?: string;
    data_tab_name?: string;
    task_status?: number; // 1 = ready
    data_link?: string; // presigned URL; body may be gzip-compressed JSON
}

// Inline content delivered with the detail response (no S3 round-trip).
// `data_content` is a JSON string keyed by the matching item's `data_id`.
export interface PlaudPreDownloadContent {
    data_id?: string;
    data_content?: string;
}

export interface PlaudFileDetail {
    file_id?: string;
    file_name?: string;
    duration?: number;
    start_time?: number;
    scene?: number;
    content_list?: PlaudContentItem[];
    pre_download_content_list?: PlaudPreDownloadContent[];
}

export interface PlaudFileDetailResponse {
    status: number; // 0 = success on this endpoint
    msg?: string;
    data?: PlaudFileDetail;
}

// A single diarized transcript segment from a 'transaction' content link.
export interface PlaudTranscriptSegment {
    start_time?: number;
    end_time?: number;
    speaker?: string | number;
    content?: string;
}

// --- Plaud 4.0 (`/file-app/v4/*`) ---
// Accounts migrated to the 4.0 platform get in-band status -1800907 from the
// 3.0 `/file/*` endpoints. All fields optional: the shapes come from live
// captures by third-party clients, not a published schema.

/** Envelope shared by every `/file-app/v4/*` endpoint. */
export interface PlaudV4Envelope<T> {
    status: number;
    msg?: string;
    data?: T;
}

/** One item of `GET /file-app/v4/recordings/all`. */
export interface PlaudV4RecordingItem {
    node_id?: string;
    file_id?: string;
    name?: string;
    duration_ms?: number;
    created_at_show_ms?: number;
    updated_at_show_ms?: number;
    start_time_ms?: number;
    version_ms?: number;
    file_size?: number;
    filesize?: number;
    file_md5?: string;
    serial_number?: string;
    device_sn?: string;
    sn?: string;
    timezone?: number;
    zonemins?: number;
    scene?: number;
    status?: number;
    file_task_status?: number;
    safe_scan?: unknown;
    parent_folder?: unknown;
}

export interface PlaudV4RecordingsPage {
    items?: PlaudV4RecordingItem[];
    next_cursor?: string | null;
}

/** One entry of `data.objects[]` in `GET /file-app/v4/files/detail/{id}`. */
export interface PlaudV4DetailObject {
    object_type?: string; // 'AUDIO' | 'TRANSCRIPT' | 'POLISHED_TRANSCRIPT' | 'SUMMARY' | 'SUMMARY_*' | 'OUTLINE' | ...
    mime_type?: string;
    content_url?: string | null; // presigned S3, fetch without auth; may be null
    object_size?: number;
    version_ms?: number;
}

export interface PlaudV4FileMeta {
    file_id?: string;
    duration?: number; // ms
    start_time?: number; // unix ms
    timezone_iana?: string;
    serial_number?: string;
    scene_source?: unknown;
    task_status?: number;
    task_status_reason?: unknown;
    version_ms?: number;
}

export interface PlaudV4FileDetail {
    node?: { node_id?: string; version_ms?: number; name?: string };
    meta?: PlaudV4FileMeta;
    objects?: PlaudV4DetailObject[];
}
