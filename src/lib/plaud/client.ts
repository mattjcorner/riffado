import { gunzipSync } from "node:zlib";
import { AppError, ErrorCode } from "@/lib/errors";
import type {
    PlaudApiError,
    PlaudDeviceListResponse,
    PlaudFileDetailResponse,
    PlaudRecording,
    PlaudRecordingsResponse,
    PlaudTempUrlResponse,
    PlaudV4Envelope,
    PlaudV4FileDetail,
    PlaudV4FileMeta,
    PlaudV4RecordingsPage,
} from "@/types/plaud";
import { plaudFetch } from "./fetch";
import { safeParseJson } from "./parse";
import { DEFAULT_SERVER_KEY, PLAUD_SERVERS, PLAUD_USER_AGENT } from "./servers";
import {
    findV4AudioUrl,
    isV4MigratedBody,
    normalizeV4Recording,
    PLAUD_V4_MAX_PAGE_SIZE,
    PLAUD_V4_MIGRATED_STATUS,
    type PlaudPlatform,
    v4DetailToFileDetail,
    v4ScopeHeaders,
} from "./v4";
import {
    listPlaudWorkspaces,
    pickPersonalWorkspaceId,
    resolveWorkspaceToken,
} from "./workspace";

export interface PlaudUpdateFilenameResponse {
    status: number;
    msg: string;
    data_file?: unknown;
}

export const DEFAULT_PLAUD_API_BASE = PLAUD_SERVERS[DEFAULT_SERVER_KEY].apiBase;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function plaudHttpError(status: number, msg: string): AppError {
    if (status === 401) {
        return new AppError(
            ErrorCode.PLAUD_INVALID_TOKEN,
            "Plaud rejected the access token. Reconnect your Plaud account.",
            401,
            { plaudStatus: status, plaudMessage: msg },
        );
    }
    if (status >= 500) {
        return new AppError(
            ErrorCode.PLAUD_UPSTREAM_ERROR,
            "Plaud is temporarily unavailable. Please try again later.",
            502,
            { plaudStatus: status, plaudMessage: msg },
        );
    }
    return new AppError(ErrorCode.PLAUD_API_ERROR, msg, 400, {
        plaudStatus: status,
    });
}

function migratedError(msg?: string): AppError {
    return new AppError(
        ErrorCode.PLAUD_API_ERROR,
        msg || "Account migrated to Plaud 4.0",
        400,
        { plaudCode: PLAUD_V4_MIGRATED_STATUS },
    );
}

function isMigratedError(err: unknown): boolean {
    return (
        err instanceof AppError &&
        err.details?.plaudCode === PLAUD_V4_MIGRATED_STATUS
    );
}

const V4_NODE_VERSION_CONFLICT = -1800313;

/** Thrown when a 4.0 recording has no downloadable audio yet. */
export const PLAUD_AUDIO_NOT_READY = "audio_not_ready";

export class PlaudClient {
    private readonly userToken: string;
    private readonly apiBase: string;
    private workspaceToken?: string;
    private resolvedWorkspaceId?: string;
    private workspaceFetchInFlight?: Promise<void>;
    private workspaceFallbackToUt = false;
    private detectedPlatform?: PlaudPlatform;
    private readonly v4Cursors = new Map<string, string | null>();
    private readonly v4Meta = new Map<string, PlaudV4FileMeta>();

    constructor(
        userToken: string,
        apiBase: string = DEFAULT_PLAUD_API_BASE,
        workspaceId?: string | null,
    ) {
        this.userToken = userToken;
        this.apiBase = apiBase;
        this.resolvedWorkspaceId = workspaceId ?? undefined;
    }

    get workspaceId(): string | undefined {
        return this.resolvedWorkspaceId;
    }

    get usingUserTokenFallback(): boolean {
        return this.workspaceFallbackToUt;
    }

    /**
     * Plaud platform this account answered on: `v3` (`/file/*`) or `v4`
     * (`/file-app/v4/*`, accounts migrated to Plaud 4.0). `undefined` until
     * the first platform-specific call.
     */
    get platform(): PlaudPlatform | undefined {
        return this.detectedPlatform;
    }

    /**
     * Run the 3.0 call; when Plaud answers -1800907 (in-band or as an error
     * body) switch this client to 4.0 for the rest of its life and run the
     * 4.0 call instead.
     */
    private async onPlatform<T>(
        v3: () => Promise<T>,
        v4: () => Promise<T>,
    ): Promise<T> {
        if (this.detectedPlatform === "v4") return v4();
        try {
            const result = await v3();
            if (!isV4MigratedBody(result)) {
                this.detectedPlatform ??= "v3";
                return result;
            }
        } catch (err) {
            if (!isMigratedError(err)) throw err;
        }
        this.markV4();
        return v4();
    }

    private markV4(): void {
        if (this.detectedPlatform === "v4") return;
        this.detectedPlatform = "v4";
        console.info(
            "[plaud] account is on Plaud 4.0, using /file-app/v4 endpoints",
        );
    }

    private async resolveV4WorkspaceId(): Promise<string> {
        if (this.resolvedWorkspaceId) return this.resolvedWorkspaceId;
        const list = await listPlaudWorkspaces(this.userToken, this.apiBase);
        this.resolvedWorkspaceId = pickPersonalWorkspaceId(list);
        return this.resolvedWorkspaceId;
    }

    private async ensureWorkspaceToken(): Promise<void> {
        if (this.workspaceToken || this.workspaceFallbackToUt) return;
        if (!this.workspaceFetchInFlight) {
            this.workspaceFetchInFlight = this.fetchWorkspaceToken();
        }
        try {
            await this.workspaceFetchInFlight;
        } finally {
            this.workspaceFetchInFlight = undefined;
        }
    }

    private async fetchWorkspaceToken(): Promise<void> {
        try {
            const { workspaceToken, workspaceId } = await resolveWorkspaceToken(
                this.userToken,
                this.apiBase,
                this.resolvedWorkspaceId,
            );
            this.workspaceToken = workspaceToken;
            this.resolvedWorkspaceId = workspaceId;
        } catch (err) {
            console.warn(
                "[plaud] workspace token mint failed, falling back to user token:",
                err instanceof Error ? err.message : err,
            );
            this.workspaceFallbackToUt = true;
        }
    }

    private async request<T>(
        endpoint: string,
        options?: RequestInit,
        retryCount = 0,
        platform: PlaudPlatform = "v3",
    ): Promise<T> {
        let bearer: string;
        let scopeHeaders: Record<string, string> = {};
        if (platform === "v4") {
            // 4.0 is scoped by header and rejects the workspace token.
            bearer = this.userToken;
            scopeHeaders = v4ScopeHeaders(await this.resolveV4WorkspaceId());
        } else {
            await this.ensureWorkspaceToken();
            bearer = this.workspaceToken ?? this.userToken;
        }
        const url = `${this.apiBase}${endpoint}`;

        try {
            const response = await plaudFetch(url, {
                ...options,
                headers: {
                    ...options?.headers,
                    ...scopeHeaders,
                    Authorization: `Bearer ${bearer}`,
                    "Content-Type": "application/json",
                    "User-Agent": PLAUD_USER_AGENT,
                },
            });

            if (response.status === 429) {
                if (retryCount < MAX_RETRIES) {
                    const retryAfter = response.headers.get("Retry-After");
                    const delay = retryAfter
                        ? Number.parseInt(retryAfter, 10) * 1000
                        : INITIAL_RETRY_DELAY * 2 ** retryCount;
                    await sleep(delay);
                    return this.request<T>(
                        endpoint,
                        options,
                        retryCount + 1,
                        platform,
                    );
                }
                const retryAfter = response.headers.get("Retry-After");
                throw new AppError(
                    ErrorCode.PLAUD_RATE_LIMITED,
                    "Too many requests to Plaud. Please try again later.",
                    429,
                    retryAfter
                        ? { retryAfter: Number.parseInt(retryAfter, 10) }
                        : undefined,
                );
            }

            if (!response.ok) {
                const error = (await response
                    .json()
                    .catch(() => ({}) as PlaudApiError)) as PlaudApiError;
                const upstreamMsg = error.msg || response.statusText;

                if (
                    response.status >= 500 &&
                    response.status < 600 &&
                    retryCount < MAX_RETRIES
                ) {
                    const delay = INITIAL_RETRY_DELAY * 2 ** retryCount;
                    await sleep(delay);
                    return this.request<T>(
                        endpoint,
                        options,
                        retryCount + 1,
                        platform,
                    );
                }

                if (isV4MigratedBody(error)) throw migratedError(error.msg);
                throw plaudHttpError(response.status, upstreamMsg);
            }

            return await safeParseJson<T>(response);
        } catch (error) {
            if (
                error instanceof TypeError &&
                error.message.includes("fetch") &&
                retryCount < MAX_RETRIES
            ) {
                const delay = INITIAL_RETRY_DELAY * 2 ** retryCount;
                await sleep(delay);
                return this.request<T>(
                    endpoint,
                    options,
                    retryCount + 1,
                    platform,
                );
            }

            if (error instanceof AppError) throw error;
            throw new AppError(
                ErrorCode.PLAUD_UPSTREAM_ERROR,
                "Failed to communicate with Plaud. Please try again later.",
                502,
            );
        }
    }

    /**
     * Fetch the device list. Validates the response shape before returning:
     * a 200 with a non-zero `status` (or missing/malformed `data_devices`) is
     * a business-level Plaud error, not a schema `PlaudDeviceListResponse`
     * guarantees -- callers that iterate `data_devices` without this check
     * crash on an undefined array (issue #231). Surfaces as a typed,
     * actionable `PLAUD_API_ERROR` instead.
     */
    async listDevices(): Promise<PlaudDeviceListResponse> {
        const body = await this.onPlatform(
            () => this.request<PlaudDeviceListResponse>("/device/list"),
            // 4.0 serves the device list in the 3.0 envelope.
            () =>
                this.request<PlaudDeviceListResponse>(
                    "/device-app/device/list",
                    undefined,
                    0,
                    "v4",
                ),
        );
        if (body?.status !== 0 || !Array.isArray(body.data_devices)) {
            throw new AppError(
                ErrorCode.PLAUD_API_ERROR,
                body?.msg ||
                    "Plaud returned an invalid device list response. Reconnect your Plaud account and try again.",
                400,
                { plaudStatus: body?.status },
            );
        }
        return body;
    }

    /**
     * List recordings in the 3.0 response shape. On a 4.0 account this pages
     * `/file-app/v4/recordings/all` by cursor and maps each item with
     * `normalizeV4Recording`; `skip` is translated to the cursor remembered
     * from the previous page, so callers must page sequentially with `skip`
     * a multiple of `limit`. 4.0 has no trash listing, so `isTrash=1` returns
     * an empty page there.
     */
    async getRecordings(
        skip: number = 0,
        limit: number = 99999,
        isTrash: number = 0,
        sortBy: string = "edit_time",
        isDesc: boolean = true,
    ): Promise<PlaudRecordingsResponse> {
        const params = new URLSearchParams({
            skip: skip.toString(),
            limit: limit.toString(),
            is_trash: isTrash.toString(),
            sort_by: sortBy,
            is_desc: isDesc.toString(),
        });

        return this.onPlatform(
            async () => {
                const body = await this.request<PlaudRecordingsResponse>(
                    `/file/simple/web?${params.toString()}`,
                );
                if (
                    !isV4MigratedBody(body) &&
                    !Array.isArray(body?.data_file_list)
                ) {
                    throw new AppError(
                        ErrorCode.PLAUD_API_ERROR,
                        body?.msg ||
                            "Plaud returned an invalid recording list response.",
                        400,
                        { plaudStatus: body?.status },
                    );
                }
                return body;
            },
            () => this.getRecordingsV4(skip, limit, isTrash, sortBy, isDesc),
        );
    }

    private async getRecordingsV4(
        skip: number,
        limit: number,
        isTrash: number,
        sortBy: string,
        isDesc: boolean,
    ): Promise<PlaudRecordingsResponse> {
        const empty: PlaudRecordingsResponse = {
            status: 0,
            msg: "",
            data_file_total: 0,
            data_file_list: [],
        };
        if (isTrash) return empty;

        const pageSize = Math.min(
            Math.max(1, Math.floor(limit)),
            PLAUD_V4_MAX_PAGE_SIZE,
        );
        const sort = sortBy === "edit_time" ? "updated" : "created";
        const order = isDesc ? "desc" : "asc";
        const keyFor = (offset: number) =>
            `${sort}:${order}:${pageSize}:${offset}`;

        let cursor: string | null | undefined;
        if (skip > 0) {
            cursor = this.v4Cursors.get(keyFor(skip));
            if (cursor === undefined) {
                // No remembered cursor: walk forward from the first page.
                let offset = 0;
                cursor = undefined;
                while (offset < skip) {
                    const page = await this.fetchV4RecordingsPage(
                        cursor ?? undefined,
                        pageSize,
                        sort,
                        order,
                    );
                    offset += pageSize;
                    this.v4Cursors.set(keyFor(offset), page.nextCursor);
                    cursor = page.nextCursor;
                    if (cursor === null) break;
                }
            }
            if (cursor === null) return empty;
        }

        const page = await this.fetchV4RecordingsPage(
            cursor ?? undefined,
            pageSize,
            sort,
            order,
        );
        this.v4Cursors.set(keyFor(skip + pageSize), page.nextCursor);

        return {
            status: 0,
            msg: "",
            data_file_total: page.recordings.length,
            data_file_list: page.recordings,
        };
    }

    private async fetchV4RecordingsPage(
        cursor: string | undefined,
        pageSize: number,
        sort: string,
        order: string,
    ): Promise<{ recordings: PlaudRecording[]; nextCursor: string | null }> {
        const params = new URLSearchParams({
            sort_by: sort,
            sort_order: order,
            page_size: pageSize.toString(),
        });
        if (cursor) params.set("cursor", cursor);

        const data = await this.requestV4<PlaudV4RecordingsPage>(
            `/file-app/v4/recordings/all?${params.toString()}`,
        );
        if (!Array.isArray(data.items)) {
            throw new AppError(
                ErrorCode.PLAUD_API_ERROR,
                "Plaud 4.0 returned an invalid recording list response.",
                400,
            );
        }
        const recordings: PlaudRecording[] = [];
        for (const item of data.items) {
            const normalized = normalizeV4Recording(item);
            if (normalized) recordings.push(normalized);
        }
        const next =
            typeof data.next_cursor === "string" && data.next_cursor
                ? data.next_cursor
                : null;
        // A cursor that does not advance would page forever.
        return {
            recordings,
            nextCursor: next && next !== cursor ? next : null,
        };
    }

    /**
     * GET/PATCH a `/file-app/v4/*` endpoint and unwrap `data`. A negative
     * in-band `status` is an error: auth-shaped messages map to
     * `PLAUD_INVALID_TOKEN`, everything else to `PLAUD_API_ERROR` with the
     * in-band code in `details.plaudCode`.
     */
    private async requestV4<T>(
        endpoint: string,
        options?: RequestInit,
    ): Promise<T> {
        const body = await this.request<PlaudV4Envelope<T>>(
            endpoint,
            options,
            0,
            "v4",
        );
        const status = body?.status;
        if (typeof status === "number" && status < 0) {
            const msg = body.msg || `Plaud 4.0 error ${status}`;
            if (/expired|token|unauthori[sz]ed/i.test(msg)) {
                throw new AppError(
                    ErrorCode.PLAUD_INVALID_TOKEN,
                    "Plaud rejected the access token. Reconnect your Plaud account.",
                    401,
                    { plaudCode: status, plaudMessage: msg },
                );
            }
            throw new AppError(ErrorCode.PLAUD_API_ERROR, msg, 400, {
                plaudCode: status,
            });
        }
        if (!body?.data || typeof body.data !== "object") {
            throw new AppError(
                ErrorCode.PLAUD_API_ERROR,
                "Plaud 4.0 returned a response without data.",
                400,
            );
        }
        return body.data;
    }

    /** Raw 4.0 file detail (`/file-app/v4/files/detail/{id}`). */
    async getV4FileDetail(fileId: string): Promise<PlaudV4FileDetail> {
        return this.requestV4<PlaudV4FileDetail>(
            `/file-app/v4/files/detail/${encodeURIComponent(fileId)}`,
        );
    }

    /**
     * Presigned audio URL. 3.0: `/file/temp-url/{id}`. 4.0 has no temp-url
     * endpoint; the URL is the `AUDIO` object's `content_url` from the file
     * detail, returned as `temp_url`.
     */
    async getTempUrl(
        fileId: string,
        isOpus: boolean = true,
    ): Promise<PlaudTempUrlResponse> {
        const params = new URLSearchParams({
            is_opus: isOpus ? "1" : "0",
        });

        return this.onPlatform(
            () =>
                this.request<PlaudTempUrlResponse>(
                    `/file/temp-url/${fileId}?${params.toString()}`,
                ),
            async () => ({
                status: 0,
                temp_url: await this.getV4AudioUrl(fileId),
            }),
        );
    }

    /**
     * Presigned audio URL of a 4.0 recording (the detail's `AUDIO` object).
     * Also remembers the detail's `meta` for `v4MetaFor`. Throws
     * `PLAUD_API_ERROR` with `details.reason === PLAUD_AUDIO_NOT_READY` when
     * Plaud has no `content_url` for the audio yet.
     */
    async getV4AudioUrl(fileId: string): Promise<string> {
        const detail = await this.getV4FileDetail(fileId);
        if (detail.meta) this.v4Meta.set(fileId, detail.meta);
        const url = findV4AudioUrl(detail);
        if (url) return url;
        throw new AppError(
            ErrorCode.PLAUD_API_ERROR,
            "Plaud has no downloadable audio for this recording yet. It will be retried on the next sync.",
            409,
            { reason: PLAUD_AUDIO_NOT_READY },
        );
    }

    /**
     * 4.0 detail `meta` (recording start, device serial, ...) captured by the
     * last audio download of `fileId`, or `undefined`.
     */
    v4MetaFor(fileId: string): PlaudV4FileMeta | undefined {
        return this.v4Meta.get(fileId);
    }

    async downloadRecording(
        fileId: string,
        preferOpus: boolean = true,
    ): Promise<Buffer> {
        try {
            const tempUrlResponse = await this.getTempUrl(fileId, preferOpus);
            const downloadUrl =
                preferOpus && tempUrlResponse.temp_url_opus
                    ? tempUrlResponse.temp_url_opus
                    : tempUrlResponse.temp_url;

            // Presigned S3 link: no Authorization header (S3 answers 400).
            const response = await plaudFetch(downloadUrl);
            if (!response.ok) {
                throw new AppError(
                    ErrorCode.PLAUD_UPSTREAM_ERROR,
                    "Failed to download recording from Plaud. Please try again later.",
                    502,
                    { plaudStatus: response.status },
                );
            }

            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError(
                ErrorCode.PLAUD_UPSTREAM_ERROR,
                "Failed to download recording from Plaud. Please try again later.",
                502,
            );
        }
    }

    /**
     * Fetch a recording's content manifest (`/file/detail/{id}`) — lists the
     * transcript / summary / note items Plaud has processed and the presigned
     * links to their bodies. Goes through `request`, so it inherits
     * workspace-token auth, retry/backoff, and 401 → PLAUD_INVALID_TOKEN.
     * NOTE: the response shape is unverified (see #204 / Phase 0).
     * On a 4.0 account the `/file-app/v4/files/detail` objects are adapted to
     * the same shape by `v4DetailToFileDetail`.
     */
    async getFileDetail(fileId: string): Promise<PlaudFileDetailResponse> {
        return this.onPlatform(
            () =>
                this.request<PlaudFileDetailResponse>(`/file/detail/${fileId}`),
            async () =>
                v4DetailToFileDetail(await this.getV4FileDetail(fileId)),
        );
    }

    /**
     * Fetch a presigned content link (transcript / summary JSON) from S3.
     * Unlike Plaud API calls this carries no auth header and is gzip-aware:
     * undici inflates transparently when `Content-Encoding: gzip` is present,
     * otherwise we detect the gzip magic bytes and inflate manually. Returns
     * parsed JSON, or the raw string when the body isn't JSON (parsers
     * tolerate both). A 403 here means an expired presign (skip this item) —
     * distinct from a dead Plaud token (401 from `getFileDetail`).
     */
    async fetchContentLink(url: string): Promise<unknown> {
        const response = await plaudFetch(url);
        if (!response.ok) {
            throw new AppError(
                ErrorCode.PLAUD_UPSTREAM_ERROR,
                "Failed to fetch Plaud content link.",
                502,
                { plaudStatus: response.status },
            );
        }

        const arrayBuffer = await response.arrayBuffer();
        let buf = Buffer.from(arrayBuffer);
        if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
            buf = gunzipSync(buf);
        }

        const text = buf.toString("utf-8");
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            await this.listDevices();
            return true;
        } catch {
            return false;
        }
    }

    async updateFilename(
        fileId: string,
        filename: string,
    ): Promise<PlaudUpdateFilenameResponse> {
        return this.onPlatform(
            () =>
                this.request<PlaudUpdateFilenameResponse>(`/file/${fileId}`, {
                    method: "PATCH",
                    body: JSON.stringify({ filename }),
                }),
            () => this.renameV4(fileId, filename),
        );
    }

    /**
     * 4.0 renames the tree node, not the file, and needs the node's current
     * `version_ms` as `origin_version`. Retries once on a version conflict.
     */
    private async renameV4(
        fileId: string,
        filename: string,
    ): Promise<PlaudUpdateFilenameResponse> {
        for (let attempt = 0; ; attempt++) {
            const detail = await this.getV4FileDetail(fileId);
            const nodeId = detail.node?.node_id;
            const version = detail.node?.version_ms;
            if (!nodeId || typeof version !== "number") {
                throw new AppError(
                    ErrorCode.PLAUD_API_ERROR,
                    "Plaud 4.0 file detail has no node to rename.",
                    400,
                );
            }
            try {
                await this.requestV4<unknown>(
                    `/file-app/v4/nodes/rename/${encodeURIComponent(nodeId)}`,
                    {
                        method: "PATCH",
                        body: JSON.stringify({
                            name: filename,
                            origin_version: version,
                        }),
                    },
                );
                return { status: 0, msg: "" };
            } catch (err) {
                if (
                    attempt === 0 &&
                    err instanceof AppError &&
                    err.details?.plaudCode === V4_NODE_VERSION_CONFLICT
                ) {
                    continue;
                }
                throw err;
            }
        }
    }
}

export * from "./types";
