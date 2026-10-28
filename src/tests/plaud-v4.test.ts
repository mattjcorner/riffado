import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";

const mockEnv = vi.hoisted(() => ({
    WEBSHARE_API_KEY: undefined as string | undefined,
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

import { AppError, ErrorCode } from "@/lib/errors";
import { fetchPlaudUserMeEmail } from "@/lib/plaud/auth";
import { PLAUD_AUDIO_NOT_READY, PlaudClient } from "@/lib/plaud/client";
import {
    isReady,
    parseSummary,
    parseTranscript,
    selectContentItems,
} from "@/lib/plaud/content";
import {
    applyV4Meta,
    findV4AudioUrl,
    md5Hex,
    normalizeV4Recording,
    v4DetailToFileDetail,
} from "@/lib/plaud/v4";
import type { PlaudV4FileDetail } from "@/types/plaud";
import {
    V3_MIGRATED_BODY,
    V4_AUDIO_URL,
    V4_META,
    V4_POLISHED_URL,
    V4_SUMMARY_BODY,
    V4_SUMMARY_URL,
    V4_TRANSCRIPT_BODY,
    V4_TRANSCRIPT_URL,
    V4_WORKSPACE_ID,
    v4DetailBody,
    v4ListBody,
    v4ListItem,
} from "./fixtures/plaud-v4";

const UT = "ut.user.token";
const WT = "wt.workspace.token";
const API_BASE = "https://api.plaud.ai";

type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;

const originalFetch = global.fetch;
let mockFetch: Mock;
let routes: Route[];

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function on(
    method: string,
    path: string,
    handler: (url: URL, init: RequestInit | undefined) => Response,
): void {
    routes.push((url, init) =>
        (init?.method ?? "GET") === method && url.pathname === path
            ? handler(url, init)
            : undefined,
    );
}

function callsTo(path: string): { url: URL; init: RequestInit | undefined }[] {
    return mockFetch.mock.calls
        .map(([u, init]) => ({
            url: new URL(String(u)),
            init: init as RequestInit | undefined,
        }))
        .filter((c) => c.url.pathname === path);
}

function header(init: RequestInit | undefined, name: string): string | null {
    return new Headers(init?.headers).get(name);
}

beforeAll(() => {
    mockFetch = vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        for (const route of routes) {
            const res = route(url, init);
            if (res) return res;
        }
        throw new Error(`unmocked ${init?.method ?? "GET"} ${url}`);
    }) as Mock;
    global.fetch = mockFetch as unknown as typeof global.fetch;
});

afterAll(() => {
    global.fetch = originalFetch;
});

beforeEach(() => {
    mockFetch.mockClear();
    routes = [];
    on("POST", `/user-app/auth/workspace/token/${V4_WORKSPACE_ID}`, () =>
        json({
            status: 0,
            data: { workspace_token: WT, workspace_id: V4_WORKSPACE_ID },
        }),
    );
});

function migratedV3(): void {
    on("GET", "/file/simple/web", () => json(V3_MIGRATED_BODY));
}

describe("normalizeV4Recording", () => {
    it("maps a 4.0 list item onto the 3.0 recording shape", () => {
        const rec = normalizeV4Recording(v4ListItem());
        expect(rec).toMatchObject({
            id: "f1",
            filename: "Weekly sync",
            duration: 125000,
            start_time: 1761000000000,
            end_time: 1761000125000,
            version_ms: 1761000500000,
            is_trash: false,
            is_trans: true,
            is_summary: true,
            filesize: 0,
            file_md5: "",
            serial_number: "",
        });
    });

    it("drops items without a file_id and falls back for missing fields", () => {
        expect(normalizeV4Recording(v4ListItem({ file_id: "" }))).toBe(
            undefined,
        );
        const rec = normalizeV4Recording({
            file_id: "f2",
            updated_at_show_ms: 1761000900000,
        });
        expect(rec).toMatchObject({
            id: "f2",
            filename: "f2",
            duration: 0,
            start_time: 1761000900000,
            version_ms: 1761000900000,
        });
    });
});

describe("v4DetailToFileDetail", () => {
    const detail = (v4DetailBody() as { data: PlaudV4FileDetail }).data;

    it("feeds the 3.0 content selection and parsers", () => {
        const adapted = v4DetailToFileDetail(detail);
        const { transcript, summary } = selectContentItems(adapted);
        expect(isReady(transcript)).toBe(true);
        expect(transcript?.data_link).toBe(V4_TRANSCRIPT_URL);
        expect(isReady(summary)).toBe(true);
        expect(summary?.data_link).toBe(V4_SUMMARY_URL);
        expect(parseTranscript(V4_TRANSCRIPT_BODY).text).toBe(
            "Hello everyone.\nSecond point.",
        );
        expect(parseTranscript(V4_TRANSCRIPT_BODY).segments[1]).toEqual({
            start_time: 1500,
            end_time: 3000,
            speaker: undefined,
            content: "Second point.",
        });
        expect(parseTranscript([]).text).toBe("");
        expect(parseSummary(V4_SUMMARY_BODY).summary).toContain("First point");
    });

    it("skips the null POLISHED_TRANSCRIPT and uses TRANSCRIPT", () => {
        const { transcript } = selectContentItems(v4DetailToFileDetail(detail));
        expect(transcript?.data_link).toBe(V4_TRANSCRIPT_URL);
    });

    it("prefers the polished transcript and skips objects without a URL", () => {
        const adapted = v4DetailToFileDetail({
            objects: [
                { object_type: "TRANSCRIPT", content_url: V4_TRANSCRIPT_URL },
                {
                    object_type: "POLISHED_TRANSCRIPT",
                    content_url: V4_POLISHED_URL,
                },
                { object_type: "SUMMARY", content_url: null },
                { object_type: "SUMMARY_BETA", content_url: V4_SUMMARY_URL },
            ],
        });
        const { transcript, summary } = selectContentItems(adapted);
        expect(transcript?.data_link).toBe(V4_POLISHED_URL);
        expect(summary?.data_link).toBe(V4_SUMMARY_URL);
    });

    it("finds the audio URL only when Plaud has generated one", () => {
        expect(findV4AudioUrl(detail)).toBe(V4_AUDIO_URL);
        expect(
            findV4AudioUrl({
                objects: [{ object_type: "AUDIO", mime_type: "audio/ogg" }],
            }),
        ).toBe(undefined);
    });
});

describe("applyV4Meta", () => {
    it("takes serial, start time and missing duration from the detail meta", () => {
        const base = normalizeV4Recording(v4ListItem({ duration_ms: 0 }));
        if (!base) throw new Error("fixture did not normalize");
        const rec = applyV4Meta(base, V4_META);
        expect(rec.serial_number).toBe("SN0000000001");
        expect(rec.start_time).toBe(V4_META.start_time);
        expect(rec.duration).toBe(125000);
        expect(rec.end_time).toBe(V4_META.start_time + 125000);
        expect(applyV4Meta(base, undefined)).toBe(base);
    });
});

describe("PlaudClient on a 3.0 account", () => {
    it("never touches the 4.0 endpoints", async () => {
        on("GET", "/file/simple/web", () =>
            json({ status: 0, data_file_total: 0, data_file_list: [] }),
        );
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        const res = await client.getRecordings(0, 50);
        expect(res.data_file_list).toEqual([]);
        expect(client.platform).toBe("v3");
        expect(callsTo("/file-app/v4/recordings/all")).toHaveLength(0);
    });

    it("rejects a 3.0 list body without data_file_list", async () => {
        on("GET", "/file/simple/web", () =>
            json({ status: -1, msg: "something else" }),
        );
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        await expect(client.getRecordings(0, 50)).rejects.toMatchObject({
            code: ErrorCode.PLAUD_API_ERROR,
            message: "something else",
        });
    });
});

describe("PlaudClient on a 4.0 account", () => {
    it("switches to /file-app/v4 on -1800907 with the user token and scope headers", async () => {
        migratedV3();
        on("GET", "/file-app/v4/recordings/all", () =>
            json(
                v4ListBody([
                    v4ListItem(),
                    v4ListItem({ file_id: "f2", name: "Call" }),
                ]),
            ),
        );
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);

        const res = await client.getRecordings(0, 50, 0, "edit_time", true);

        expect(client.platform).toBe("v4");
        expect(res.data_file_list.map((r) => r.id)).toEqual(["f1", "f2"]);
        const [call] = callsTo("/file-app/v4/recordings/all");
        expect(call.url.searchParams.get("page_size")).toBe("50");
        expect(call.url.searchParams.get("sort_by")).toBe("updated");
        expect(call.url.searchParams.get("sort_order")).toBe("desc");
        expect(call.url.searchParams.has("cursor")).toBe(false);
        expect(header(call.init, "authorization")).toBe(`Bearer ${UT}`);
        expect(header(call.init, "x-scope-type")).toBe("workspace");
        expect(header(call.init, "x-scope-id")).toBe(V4_WORKSPACE_ID);
        expect(header(call.init, "app-platform")).toBe("web");
        expect(header(call.init, "edit-from")).toBe("web");

        await client.getRecordings(0, 50);
        expect(callsTo("/file/simple/web")).toHaveLength(1);
    });

    it("also switches when -1800907 arrives as an HTTP error body", async () => {
        on("GET", "/file/simple/web", () => json(V3_MIGRATED_BODY, 400));
        on("GET", "/file-app/v4/recordings/all", () =>
            json(v4ListBody([v4ListItem()])),
        );
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        const res = await client.getRecordings(0, 50);
        expect(res.data_file_list).toHaveLength(1);
        expect(client.platform).toBe("v4");
    });

    it("translates sequential skip paging into cursors", async () => {
        migratedV3();
        on("GET", "/file-app/v4/recordings/all", (url) => {
            const cursor = url.searchParams.get("cursor");
            if (!cursor) {
                return json(
                    v4ListBody(
                        [v4ListItem(), v4ListItem({ file_id: "f2" })],
                        "C2",
                    ),
                );
            }
            if (cursor === "C2") {
                return json(v4ListBody([v4ListItem({ file_id: "f3" })], null));
            }
            throw new Error(`unexpected cursor ${cursor}`);
        });
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);

        const p1 = await client.getRecordings(0, 2);
        const p2 = await client.getRecordings(2, 2);
        const p3 = await client.getRecordings(4, 2);

        expect(p1.data_file_list.map((r) => r.id)).toEqual(["f1", "f2"]);
        expect(p2.data_file_list.map((r) => r.id)).toEqual(["f3"]);
        expect(p3.data_file_list).toEqual([]);
        expect(callsTo("/file-app/v4/recordings/all")).toHaveLength(2);
    });

    it("walks from the first page when asked for an unseen offset", async () => {
        migratedV3();
        on("GET", "/file-app/v4/recordings/all", (url) =>
            url.searchParams.get("cursor") === "C2"
                ? json(v4ListBody([v4ListItem({ file_id: "f3" })]))
                : json(v4ListBody([v4ListItem()], "C2")),
        );
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        const res = await client.getRecordings(1, 1);
        expect(res.data_file_list.map((r) => r.id)).toEqual(["f3"]);
    });

    it("returns an empty trash page without calling Plaud", async () => {
        migratedV3();
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        on("GET", "/file-app/v4/recordings/all", () =>
            json(v4ListBody([v4ListItem()])),
        );
        await client.getRecordings(0, 1);
        const trash = await client.getRecordings(0, 1, 1);
        expect(trash.data_file_list).toEqual([]);
        expect(callsTo("/file-app/v4/recordings/all")).toHaveLength(1);
    });

    it("resolves the workspace id when the connection has none cached", async () => {
        migratedV3();
        on("GET", "/team-app/workspaces/list", () =>
            json({
                status: 0,
                data: {
                    workspaces: [
                        { workspace_id: "ws_team", workspace_type: "1" },
                        {
                            workspace_id: V4_WORKSPACE_ID,
                            workspace_type: "0",
                        },
                    ],
                },
            }),
        );
        on("GET", "/file-app/v4/recordings/all", () =>
            json(v4ListBody([v4ListItem()])),
        );
        const client = new PlaudClient(UT, API_BASE);
        await client.getRecordings(0, 50);
        const [call] = callsTo("/file-app/v4/recordings/all");
        expect(header(call.init, "x-scope-id")).toBe(V4_WORKSPACE_ID);
    });

    it("maps negative in-band 4.0 statuses to typed errors", async () => {
        migratedV3();
        on("GET", "/file-app/v4/recordings/all", () =>
            json({ status: -1, msg: "token expired" }),
        );
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        await expect(client.getRecordings(0, 50)).rejects.toMatchObject({
            code: ErrorCode.PLAUD_INVALID_TOKEN,
        });
    });

    it("adapts the 4.0 detail for content import", async () => {
        migratedV3();
        on("GET", "/file-app/v4/recordings/all", () =>
            json(v4ListBody([v4ListItem()])),
        );
        on("GET", "/file-app/v4/files/detail/f1", () => json(v4DetailBody()));
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        await client.getRecordings(0, 50);
        const detail = await client.getFileDetail("f1");
        expect(selectContentItems(detail).transcript?.data_link).toBe(
            V4_TRANSCRIPT_URL,
        );
        expect(callsTo("/file/detail/f1")).toHaveLength(0);
    });

    it("downloads audio from the detail's AUDIO object", async () => {
        migratedV3();
        on("GET", "/file-app/v4/recordings/all", () =>
            json(v4ListBody([v4ListItem()])),
        );
        on("GET", "/file-app/v4/files/detail/f1", () => json(v4DetailBody()));
        on("GET", "/audio.ogg", () => new Response(Buffer.from("OggS-audio")));
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        await client.getRecordings(0, 50);

        const audio = await client.downloadRecording("f1", false);
        expect(audio.toString()).toBe("OggS-audio");
        const [s3] = callsTo("/audio.ogg");
        expect(header(s3.init, "authorization")).toBe(null);
    });

    it("serves getTempUrl from the detail and keeps its meta", async () => {
        migratedV3();
        on("GET", "/file-app/v4/recordings/all", () =>
            json(v4ListBody([v4ListItem()])),
        );
        on("GET", "/file-app/v4/files/detail/f1", () => json(v4DetailBody()));
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        await client.getRecordings(0, 50);

        const res = await client.getTempUrl("f1", false);
        expect(res.temp_url).toBe(V4_AUDIO_URL);
        expect(client.v4MetaFor("f1")).toEqual(V4_META);
        expect(callsTo("/file/temp-url/f1")).toHaveLength(0);
    });

    it("reports audio-not-ready when the AUDIO content_url is null", async () => {
        on("GET", "/file/temp-url/f1", () => json(V3_MIGRATED_BODY));
        on("GET", "/file-app/v4/files/detail/f1", () =>
            json(
                v4DetailBody([
                    {
                        object_type: "AUDIO",
                        mime_type: "audio/ogg",
                        content_url: null,
                        object_size: 0,
                        version_ms: 1761000500000,
                    },
                ]),
            ),
        );
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        const err = await client
            .downloadRecording("f1", false)
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).details?.reason).toBe(PLAUD_AUDIO_NOT_READY);
        expect(client.platform).toBe("v4");

        await client.downloadRecording("f1", false).catch(() => undefined);
        expect(callsTo("/file/temp-url/f1")).toHaveLength(1);
    });

    it("fetches transcript and summary content without Plaud auth", async () => {
        on("GET", "/transcript", () => json(V4_TRANSCRIPT_BODY));
        on("GET", "/summary", () => new Response(V4_SUMMARY_BODY));
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);

        const transcript = parseTranscript(
            await client.fetchContentLink(V4_TRANSCRIPT_URL),
        );
        const summary = parseSummary(
            await client.fetchContentLink(V4_SUMMARY_URL),
        );

        expect(transcript.text).toBe("Hello everyone.\nSecond point.");
        expect(summary.summary).toContain("Second point");
        for (const path of ["/transcript", "/summary"]) {
            const [call] = callsTo(path);
            expect(header(call.init, "authorization")).toBe(null);
        }
    });

    it("falls back to /device-app/device/list", async () => {
        on("GET", "/device/list", () => json(V3_MIGRATED_BODY));
        on("GET", "/device-app/device/list", () =>
            json({
                status: 0,
                msg: "success",
                data_devices: [
                    {
                        sn: "SN000000",
                        name: "PLAUD NOTE",
                        model: "888",
                        version_number: 1,
                    },
                ],
            }),
        );
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        const res = await client.listDevices();
        expect(res.data_devices).toHaveLength(1);
        const [call] = callsTo("/device-app/device/list");
        expect(header(call.init, "authorization")).toBe(`Bearer ${UT}`);
    });

    it("renames the tree node with its current version", async () => {
        on("PATCH", "/file/f1", () => json(V3_MIGRATED_BODY));
        on("GET", "/file-app/v4/files/detail/f1", () => json(v4DetailBody()));
        on("PATCH", "/file-app/v4/nodes/rename/n_sp_f1", () =>
            json({ status: 0, data: {} }),
        );
        const client = new PlaudClient(UT, API_BASE, V4_WORKSPACE_ID);
        await client.updateFilename("f1", "New title");
        const [call] = callsTo("/file-app/v4/nodes/rename/n_sp_f1");
        expect(JSON.parse(String(call.init?.body))).toEqual({
            name: "New title",
            origin_version: 1761000500000,
        });
    });
});

describe("md5Hex", () => {
    it("produces a 32-char hex digest", () => {
        expect(md5Hex(Buffer.from("abc"))).toBe(
            "900150983cd24fb0d6963f7d28e17f72",
        );
    });
});

describe("fetchPlaudUserMeEmail", () => {
    it("reads the email from data_user", async () => {
        on("GET", "/user/me", () =>
            json({ status: 0, data_user: { email: "User@Example.com" } }),
        );
        expect(await fetchPlaudUserMeEmail(UT, API_BASE)).toBe(
            "user@example.com",
        );
    });
});
