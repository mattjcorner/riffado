import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type * as AuthRequest from "@/lib/auth-request";

vi.mock("@/lib/env", () => ({
    env: {
        BETTER_AUTH_SECRET: "better-auth-secret-with-32-chars",
        API_TOKEN_HASH_SECRET: undefined,
    },
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
    },
}));

vi.mock("@/lib/auth", () => ({
    auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@/lib/auth-request", async (importOriginal) => ({
    ...(await importOriginal<typeof AuthRequest>()),
    authenticateRequest: vi.fn(),
}));

vi.mock("@/lib/v1/rate-limit", () => ({
    enforceV1IpRateLimit: vi.fn().mockResolvedValue(null),
    enforceV1AuthenticatedRateLimit: vi.fn().mockResolvedValue(null),
    enforceV1WriteRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/entitlements", () => ({
    isHostedLockedOut: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/transcription/persist", () => ({
    upsertTranscription: vi.fn(),
    upsertEnhancement: vi.fn(),
}));

vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string | null) => v,
    decryptJsonField: (v: unknown) => v ?? null,
}));

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn(),
}));

import {
    GET as getSummary,
    PUT as putSummary,
} from "@/app/api/v1/recordings/[id]/summary/route";
import {
    GET as getTranscript,
    PUT as putTranscript,
} from "@/app/api/v1/recordings/[id]/transcript/route";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { authenticateRequest } from "@/lib/auth-request";
import { isHostedLockedOut } from "@/lib/entitlements";
import { ErrorCode } from "@/lib/errors";
import {
    upsertEnhancement,
    upsertTranscription,
} from "@/lib/transcription/persist";
import { enforceV1WriteRateLimit } from "@/lib/v1/rate-limit";
import { emitEvent } from "@/lib/webhooks/emit";

const now = new Date("2026-05-06T12:00:00.000Z");

const readKey = {
    user: { id: "user-1" },
    via: "api-key" as const,
    apiKeyId: "key-read",
    scopes: ["read" as const],
};

const writeKey = {
    user: { id: "user-1" },
    via: "api-key" as const,
    apiKeyId: "key-write",
    scopes: ["read" as const, "write" as const],
};

function transcriptRow(source: string, text: string) {
    return {
        id: `tr-${source}`,
        recordingId: "rec-1",
        userId: "user-1",
        text,
        detectedLanguage: "en",
        transcriptionType: "server",
        provider: source === "external" ? "external" : "openai",
        model: "whisper-1",
        source,
        createdAt: now,
    };
}

const summaryRow = {
    id: "sum-1",
    recordingId: "rec-1",
    userId: "user-1",
    summary: "## Decisions\n- Ship it",
    keyPoints: ["Budget approved"],
    actionItems: ["Alice sends the deck"],
    provider: "external",
    model: "my-model",
    source: "external",
    createdAt: now,
};

/** Queue `db.select()` results in call order; captures each `where` arg. */
function queueSelects(...results: unknown[][]) {
    const wheres: unknown[] = [];
    for (const rows of results) {
        (db.select as Mock).mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn((expr: unknown) => {
                    wheres.push(expr);
                    return Object.assign(Promise.resolve(rows), {
                        limit: vi.fn().mockResolvedValue(rows),
                    });
                }),
            }),
        });
    }
    return wheres;
}

function exprReferencesColumn(
    expr: unknown,
    col: unknown,
    seen = new Set<unknown>(),
): boolean {
    if (expr == null || typeof expr !== "object") return false;
    if (expr === col) return true;
    if (seen.has(expr)) return false;
    seen.add(expr);
    for (const key of ["queryChunks", "value", "left", "right", "chunks"]) {
        const value = (expr as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
            if (value.some((item) => exprReferencesColumn(item, col, seen))) {
                return true;
            }
        } else if (exprReferencesColumn(value, col, seen)) {
            return true;
        }
    }
    return false;
}

function put(path: string, body: unknown, headers: HeadersInit = {}) {
    return new Request(`http://localhost/api/v1/recordings/rec-1/${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
}

const ctx = { params: Promise.resolve({ id: "rec-1" }) };

describe("PUT /api/v1/recordings/{id}/transcript", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (authenticateRequest as Mock).mockResolvedValue(writeKey);
        (upsertTranscription as Mock).mockResolvedValue({ committed: true });
    });

    it("refuses a read-only key with 403 FORBIDDEN", async () => {
        (authenticateRequest as Mock).mockResolvedValue(readKey);

        const response = await putTranscript(
            put("transcript", { text: "hello" }),
            ctx,
        );

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
            error: "This API key does not have the write scope",
            code: ErrorCode.FORBIDDEN,
            details: { requiredScope: "write" },
        });
        expect(upsertTranscription).not.toHaveBeenCalled();
        expect(enforceV1WriteRateLimit).not.toHaveBeenCalled();
    });

    it("refuses an unauthenticated request with 401", async () => {
        (authenticateRequest as Mock).mockResolvedValue(null);

        const response = await putTranscript(
            put("transcript", { text: "hello" }),
            ctx,
        );

        expect(response.status).toBe(401);
        expect(upsertTranscription).not.toHaveBeenCalled();
    });

    it("stores named-speaker segments as the external source for the key's user", async () => {
        const wheres = queueSelects(
            [{ id: "rec-1" }],
            [
                transcriptRow(
                    "external",
                    "[00:00] Alice: Hello.\n[01:05] Bob: Hi there.",
                ),
            ],
        );

        const response = await putTranscript(
            put("transcript", {
                segments: [
                    { speaker: "Alice", text: "Hello.", start: 0 },
                    { speaker: "Bob", text: "Hi\nthere.", start: 65.4 },
                ],
                language: "en",
                model: "my-diarizer",
            }),
            ctx,
        );

        expect(response.status).toBe(200);
        expect(upsertTranscription).toHaveBeenCalledWith({
            userId: "user-1",
            recordingId: "rec-1",
            text: "[00:00] Alice: Hello.\n[01:05] Bob: Hi there.",
            detectedLanguage: "en",
            source: "external",
            provider: "external",
            model: "my-diarizer",
        });
        expect(exprReferencesColumn(wheres[0], recordings.userId)).toBe(true);
        expect(exprReferencesColumn(wheres[0], recordings.deletedAt)).toBe(
            true,
        );
        await expect(response.json()).resolves.toMatchObject({
            source: "external",
            text: "[00:00] Alice: Hello.\n[01:05] Bob: Hi there.",
        });
        expect(emitEvent).not.toHaveBeenCalled();
    });

    it("stores plain text verbatim", async () => {
        queueSelects([{ id: "rec-1" }], [transcriptRow("external", "x")]);

        const response = await putTranscript(
            put("transcript", { text: "Alice: one\nBob: two" }),
            ctx,
        );

        expect(response.status).toBe(200);
        expect(upsertTranscription).toHaveBeenCalledWith(
            expect.objectContaining({
                text: "Alice: one\nBob: two",
                detectedLanguage: null,
                provider: "external",
                model: "unknown",
                source: "external",
            }),
        );
    });

    it("answers 404 for a recording the user does not own (or that is deleted)", async () => {
        queueSelects([]);

        const response = await putTranscript(
            put("transcript", { text: "hello" }),
            ctx,
        );

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.RECORDING_NOT_FOUND,
        });
        expect(upsertTranscription).not.toHaveBeenCalled();
    });

    it("answers 410 when the recording is deleted during the write", async () => {
        queueSelects([{ id: "rec-1" }]);
        (upsertTranscription as Mock).mockResolvedValue({ committed: false });

        const response = await putTranscript(
            put("transcript", { text: "hello" }),
            ctx,
        );

        expect(response.status).toBe(410);
    });

    it.each([
        ["neither text nor segments", {}],
        ["both text and segments", { text: "a", segments: [] }],
        [
            "a speaker name with a colon",
            { segments: [{ speaker: "A:B", text: "x" }] },
        ],
        [
            "an over-long speaker name",
            { segments: [{ speaker: "x".repeat(41), text: "x" }] },
        ],
        [
            "a negative start",
            { segments: [{ speaker: "A", text: "x", start: -1 }] },
        ],
        ["a malformed language", { text: "a", language: "english!" }],
    ])("rejects %s with 400 INVALID_INPUT", async (_label, body) => {
        const response = await putTranscript(put("transcript", body), ctx);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.INVALID_INPUT,
        });
        expect(upsertTranscription).not.toHaveBeenCalled();
    });

    it("rejects a non-JSON body with 400", async () => {
        const response = await putTranscript(put("transcript", "{nope"), ctx);
        expect(response.status).toBe(400);
    });

    it("rejects an oversized body with 413 before parsing it", async () => {
        const response = await putTranscript(
            put("transcript", { text: "a".repeat(2 * 1024 * 1024 + 1) }),
            ctx,
        );

        expect(response.status).toBe(413);
        expect(upsertTranscription).not.toHaveBeenCalled();
    });

    it("passes the write bucket's 429 through", async () => {
        (enforceV1WriteRateLimit as Mock).mockResolvedValueOnce(
            new Response("{}", { status: 429 }),
        );

        const response = await putTranscript(
            put("transcript", { text: "hello" }),
            ctx,
        );

        expect(response.status).toBe(429);
        expect(upsertTranscription).not.toHaveBeenCalled();
    });

    it("refuses a hosted account that is locked out", async () => {
        (isHostedLockedOut as Mock).mockResolvedValueOnce(true);

        const response = await putTranscript(
            put("transcript", { text: "hello" }),
            ctx,
        );

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.ACCOUNT_LOCKED,
        });
    });

    it("accepts a browser session without an API-key scope list", async () => {
        (authenticateRequest as Mock).mockResolvedValue({
            user: { id: "user-1" },
            via: "session",
        });
        queueSelects([{ id: "rec-1" }], [transcriptRow("external", "x")]);

        const response = await putTranscript(
            put("transcript", { text: "hello" }),
            ctx,
        );

        expect(response.status).toBe(200);
    });
});

describe("GET /api/v1/recordings/{id}/transcript", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (authenticateRequest as Mock).mockResolvedValue(readKey);
    });

    it("prefers the external transcript over the user's own provider by default", async () => {
        queueSelects(
            [{ id: "rec-1" }],
            [
                transcriptRow("riffado", "from riffado"),
                transcriptRow("external", "from automation"),
            ],
            [{ preferred: "plaud" }],
        );

        const response = await getTranscript(
            new Request("http://localhost/api/v1/recordings/rec-1/transcript"),
            ctx,
        );

        await expect(response.json()).resolves.toMatchObject({
            source: "external",
            text: "from automation",
        });
    });

    it("returns a specific source with ?source=", async () => {
        queueSelects(
            [{ id: "rec-1" }],
            [
                transcriptRow("plaud", "from plaud"),
                transcriptRow("external", "from automation"),
            ],
        );

        const response = await getTranscript(
            new Request(
                "http://localhost/api/v1/recordings/rec-1/transcript?source=plaud",
            ),
            ctx,
        );

        await expect(response.json()).resolves.toMatchObject({
            source: "plaud",
            text: "from plaud",
        });
    });

    it("answers 404 for a source the recording does not have", async () => {
        queueSelects([{ id: "rec-1" }], [transcriptRow("riffado", "x")]);

        const response = await getTranscript(
            new Request(
                "http://localhost/api/v1/recordings/rec-1/transcript?source=external",
            ),
            ctx,
        );

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
            code: ErrorCode.NOT_FOUND,
        });
    });
});

describe("/api/v1/recordings/{id}/summary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (authenticateRequest as Mock).mockResolvedValue(writeKey);
        (upsertEnhancement as Mock).mockResolvedValue({ committed: true });
    });

    it("refuses a read-only key with 403", async () => {
        (authenticateRequest as Mock).mockResolvedValue(readKey);

        const response = await putSummary(
            put("summary", { text: "# Summary" }),
            ctx,
        );

        expect(response.status).toBe(403);
        expect(upsertEnhancement).not.toHaveBeenCalled();
    });

    it("upserts the summary with source external and returns it", async () => {
        queueSelects([{ id: "rec-1" }], [summaryRow]);

        const response = await putSummary(
            put("summary", {
                text: "## Decisions\n- Ship it",
                key_points: ["Budget approved"],
                action_items: ["Alice sends the deck"],
                model: "my-model",
            }),
            ctx,
        );

        expect(response.status).toBe(200);
        expect(upsertEnhancement).toHaveBeenCalledWith({
            userId: "user-1",
            recordingId: "rec-1",
            summary: "## Decisions\n- Ship it",
            keyPoints: ["Budget approved"],
            actionItems: ["Alice sends the deck"],
            source: "external",
            provider: "external",
            model: "my-model",
        });
        await expect(response.json()).resolves.toEqual({
            source: "external",
            text: "## Decisions\n- Ship it",
            key_points: ["Budget approved"],
            action_items: ["Alice sends the deck"],
            provider: "external",
            model: "my-model",
            created_at: now.toISOString(),
        });
        expect(emitEvent).not.toHaveBeenCalled();
    });

    it("defaults key points and action items to empty lists", async () => {
        queueSelects([{ id: "rec-1" }], [summaryRow]);

        await putSummary(put("summary", { text: "Short." }), ctx);

        expect(upsertEnhancement).toHaveBeenCalledWith(
            expect.objectContaining({
                keyPoints: [],
                actionItems: [],
                model: "unknown",
            }),
        );
    });

    it("rejects an empty summary and non-string list items", async () => {
        for (const body of [
            { text: "" },
            { text: "ok", key_points: [1] },
            { text: "ok", action_items: "one" },
        ]) {
            const response = await putSummary(put("summary", body), ctx);
            expect(response.status).toBe(400);
        }
        expect(upsertEnhancement).not.toHaveBeenCalled();
    });

    it("answers 404 for another user's recording and 410 on a mid-write delete", async () => {
        queueSelects([]);
        const missing = await putSummary(put("summary", { text: "x" }), ctx);
        expect(missing.status).toBe(404);

        queueSelects([{ id: "rec-1" }]);
        (upsertEnhancement as Mock).mockResolvedValue({ committed: false });
        const deleted = await putSummary(put("summary", { text: "x" }), ctx);
        expect(deleted.status).toBe(410);
    });

    it("GET returns the summary to a read key, or 404 when there is none", async () => {
        (authenticateRequest as Mock).mockResolvedValue(readKey);
        queueSelects([{ id: "rec-1" }], [summaryRow]);

        const found = await getSummary(
            new Request("http://localhost/api/v1/recordings/rec-1/summary"),
            ctx,
        );
        expect(found.status).toBe(200);
        await expect(found.json()).resolves.toMatchObject({
            source: "external",
            text: "## Decisions\n- Ship it",
        });

        queueSelects([{ id: "rec-1" }], []);
        const none = await getSummary(
            new Request("http://localhost/api/v1/recordings/rec-1/summary"),
            ctx,
        );
        expect(none.status).toBe(404);
    });
});
