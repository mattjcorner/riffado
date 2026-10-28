import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { aiEnhancements } from "@/db/schema";
import { authenticateRequest } from "@/lib/auth-request";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { upsertEnhancement } from "@/lib/transcription/persist";
import {
    enforceV1AuthenticatedRateLimit,
    enforceV1IpRateLimit,
} from "@/lib/v1/rate-limit";
import { serializeSummary } from "@/lib/v1/serialize";
import {
    assertV1RecordingExists,
    authorizeV1Write,
    parseV1JsonBody,
    recordingDeletedError,
} from "@/lib/v1/write";

type IdContext = { params: Promise<{ id: string }> };

const listSchema = z
    .array(z.string().trim().min(1).max(2_000))
    .max(200)
    .optional()
    .transform((v) => v ?? []);

const putBodySchema = z.object({
    text: z.string().trim().min(1).max(200_000),
    key_points: listSchema,
    action_items: listSchema,
    provider: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .transform((v) => v ?? "external"),
    model: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .transform((v) => v ?? "unknown"),
});

async function loadSummary(userId: string, recordingId: string) {
    const [enhancement] = await db
        .select()
        .from(aiEnhancements)
        .where(
            and(
                eq(aiEnhancements.recordingId, recordingId),
                eq(aiEnhancements.userId, userId),
            ),
        )
        .limit(1);
    return enhancement ?? null;
}

export const GET = apiHandler<IdContext>(async (request, context) => {
    const ipLimitResponse = await enforceV1IpRateLimit(request);
    if (ipLimitResponse) return ipLimitResponse;

    const authn = await authenticateRequest(request);
    if (!authn) {
        throw new AppError(ErrorCode.UNAUTHORIZED, "Unauthorized", 401);
    }

    const authLimitResponse = await enforceV1AuthenticatedRateLimit(authn);
    if (authLimitResponse) return authLimitResponse;

    const { id } = await (context as IdContext).params;
    await assertV1RecordingExists(authn.user.id, id);

    const summary = serializeSummary(await loadSummary(authn.user.id, id));
    if (!summary) {
        throw new AppError(ErrorCode.NOT_FOUND, "Summary not found", 404, {
            id,
        });
    }
    return NextResponse.json(summary);
});

/**
 * Store the caller's own summary (markdown) as the recording's summary,
 * with `source: "external"`. A recording has one summary, so this replaces
 * whatever summary it had. Requires the `write` scope.
 */
export const PUT = apiHandler<IdContext>(async (request, context) => {
    const authn = await authorizeV1Write(request);
    if (authn instanceof Response) return authn;

    const { id } = await (context as IdContext).params;
    const body = await parseV1JsonBody(request, putBodySchema);
    await assertV1RecordingExists(authn.user.id, id);

    const { committed } = await upsertEnhancement({
        userId: authn.user.id,
        recordingId: id,
        summary: body.text,
        keyPoints: body.key_points,
        actionItems: body.action_items,
        source: "external",
        provider: body.provider,
        model: body.model,
    });
    if (!committed) throw recordingDeletedError(id);

    return NextResponse.json(
        serializeSummary(await loadSummary(authn.user.id, id)),
    );
});
