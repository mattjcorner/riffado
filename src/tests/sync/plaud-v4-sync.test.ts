import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        DEFAULT_STORAGE_TYPE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock("@/lib/entitlements", () => ({
    isHostedLockedOut: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/hosted/billing/storage-cap", () => ({
    enforceStorageCap: vi.fn().mockResolvedValue({
        allowed: true,
        currentBytes: 0,
        limitBytes: null,
    }),
}));

vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        uploadFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock("@/lib/notifications/bark", () => ({
    sendNewRecordingBarkNotification: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/notifications/email", () => ({
    sendNewRecordingEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/transcription/transcribe-recording", () => ({
    transcribeRecording: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/posthog-server", () => ({
    captureServerEvent: vi.fn(),
    captureServerException: vi.fn(),
}));

import { db } from "@/db";
import { createPlaudClient } from "@/lib/plaud/client-factory";
import { md5Hex, normalizeV4Recording } from "@/lib/plaud/v4";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";
import { V4_META, v4ListItem } from "../fixtures/plaud-v4";

const USER_ID = "user-v4";

function oggBytes(): Buffer {
    const buf = Buffer.alloc(48, 0);
    buf.write("OggS", 0);
    buf.write("OpusHead", 28);
    return buf;
}

function stubSelects(results: unknown[][]) {
    const chain = (db.select as Mock).mockReset();
    for (const result of results) {
        chain.mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue(result),
                }),
            }),
        });
    }
}

describe("sync of a Plaud 4.0 recording", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("stores size and md5 from the downloaded audio when 4.0 omits them", async () => {
        const audio = oggBytes();
        const recording = normalizeV4Recording(v4ListItem());
        (createPlaudClient as Mock).mockResolvedValue({
            getRecordings: vi
                .fn()
                .mockResolvedValue({ data_file_list: [recording] }),
            downloadRecording: vi.fn().mockResolvedValue(audio),
            workspaceId: "ws_000000000000",
        });
        stubSelects([
            [{ id: "conn-1", userId: USER_ID, bearerToken: "tok" }],
            [{ id: "settings-1" }],
            [{ email: "t@example.com" }],
            [],
            [],
        ]);
        const values = vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "new-rec" }]),
        });
        (db.insert as Mock).mockReturnValue({ values });
        (db.update as Mock).mockReturnValue({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await syncRecordingsForUser(USER_ID);

        expect(result.errors).toEqual([]);
        expect(result.newRecordings).toBe(1);
        expect(values).toHaveBeenCalledWith(
            expect.objectContaining({
                plaudFileId: "f1",
                duration: 125000,
                startTime: new Date(1761000000000),
                endTime: new Date(1761000125000),
                filesize: audio.length,
                fileMd5: md5Hex(audio),
                plaudVersion: "1761000500000",
                deviceSn: "",
            }),
        );
    });

    it("uses the detail meta for device serial and start time on 4.0", async () => {
        const audio = oggBytes();
        const recording = normalizeV4Recording(v4ListItem());
        (createPlaudClient as Mock).mockResolvedValue({
            platform: "v4",
            getRecordings: vi
                .fn()
                .mockResolvedValue({ data_file_list: [recording] }),
            downloadRecording: vi.fn().mockResolvedValue(audio),
            v4MetaFor: vi.fn().mockReturnValue(V4_META),
            workspaceId: "ws_000000000000",
        });
        stubSelects([
            [{ id: "conn-1", userId: USER_ID, bearerToken: "tok" }],
            [{ id: "settings-1" }],
            [{ email: "t@example.com" }],
            [],
            [],
        ]);
        const values = vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "new-rec" }]),
        });
        (db.insert as Mock).mockReturnValue({ values });
        (db.update as Mock).mockReturnValue({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await syncRecordingsForUser(USER_ID);

        expect(result.errors).toEqual([]);
        expect(values).toHaveBeenCalledWith(
            expect.objectContaining({
                deviceSn: "SN0000000001",
                startTime: new Date(V4_META.start_time),
                endTime: new Date(V4_META.start_time + 125000),
            }),
        );
    });
});
