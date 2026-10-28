import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { authenticateRequest } from "@/lib/auth-request";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { upsertTranscription } from "@/lib/transcription/persist";
import {
    formatSpeakerSegments,
    SPEAKER_NAME_FORBIDDEN,
    SPEAKER_NAME_MAX_LENGTH,
} from "@/lib/transcription/speaker-text";
import {
    enforceV1AuthenticatedRateLimit,
    enforceV1IpRateLimit,
} from "@/lib/v1/rate-limit";
import {
    getPreferredTranscriptSource,
    resolvePrimaryTranscript,
    serializeTranscript,
} from "@/lib/v1/serialize";
import {
    assertV1RecordingExists,
    authorizeV1Write,
    parseV1JsonBody,
    recordingDeletedError,
} from "@/lib/v1/write";

type IdContext = { params: Promise<{ id: string }> };

const MAX_TRANSCRIPT_LENGTH = 500_000;

const segmentSchema = z.object({
    speaker: z
        .string()
        .trim()
        .min(1)
        .max(SPEAKER_NAME_MAX_LENGTH)
        .refine((name) => !SPEAKER_NAME_FORBIDDEN.test(name), {
            message: 'Speaker names cannot contain : [ ] ? ! ; " or newlines',
        }),
    text: z.string().trim().min(1),
    start: z.number().finite().min(0).optional(),
});

const putBodySchema = z
    .object({
        text: z.string().trim().min(1).max(MAX_TRANSCRIPT_LENGTH).optional(),
        segments: z.array(segmentSchema).min(1).max(20_000).optional(),
        language: z
            .string()
            .trim()
            .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,6})?$/)
            .nullish()
            .transform((v) => v ?? null),
        provider: z.string().trim().min(1).max(100).optional(),
        model: z.string().trim().min(1).max(100).optional(),
    })
    .refine((body) => (body.text === undefined) !== !body.segments, {
        message: "Provide exactly one of text or segments",
        path: ["text"],
    })
    .transform((body, ctx) => {
        const text = body.segments
            ? formatSpeakerSegments(body.segments)
            : (body.text ?? "");
        if (text.length > MAX_TRANSCRIPT_LENGTH) {
            ctx.addIssue({
                code: "custom",
                message: `Transcript exceeds ${MAX_TRANSCRIPT_LENGTH} characters`,
                path: ["segments"],
            });
            return z.NEVER;
        }
        return {
            text,
            language: body.language,
            provider: body.provider ?? "external",
            model: body.model ?? "unknown",
        };
    });

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
    const source = new URL(request.url).searchParams.get("source");
    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, authn.user.id),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);

    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
            { id },
        );
    }

    const transcriptRows = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recording.id),
                eq(transcriptions.userId, authn.user.id),
            ),
        );

    const primary = source
        ? (transcriptRows.find((t) => t.source === source) ?? null)
        : resolvePrimaryTranscript(
              transcriptRows,
              await getPreferredTranscriptSource(authn.user.id),
          );

    if (!primary) {
        throw new AppError(ErrorCode.NOT_FOUND, "Transcript not found", 404, {
            id,
            ...(source ? { source } : {}),
        });
    }

    return NextResponse.json(serializeTranscript(primary));
});

/**
 * Store the caller's own transcript as the recording's `external` source.
 * Replaces a previous external transcript; Riffado and Plaud transcripts
 * are never touched. Requires the `write` scope.
 */
export const PUT = apiHandler<IdContext>(async (request, context) => {
    const authn = await authorizeV1Write(request);
    if (authn instanceof Response) return authn;

    const { id } = await (context as IdContext).params;
    const body = await parseV1JsonBody(request, putBodySchema);
    await assertV1RecordingExists(authn.user.id, id);

    const { committed } = await upsertTranscription({
        userId: authn.user.id,
        recordingId: id,
        text: body.text,
        detectedLanguage: body.language,
        source: "external",
        provider: body.provider,
        model: body.model,
    });
    if (!committed) throw recordingDeletedError(id);

    const [stored] = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, id),
                eq(transcriptions.userId, authn.user.id),
                eq(transcriptions.source, "external"),
            ),
        )
        .limit(1);

    return NextResponse.json(serializeTranscript(stored ?? null));
});
