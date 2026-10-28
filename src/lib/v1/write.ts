import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import {
    type AuthenticatedRequest,
    authenticateRequest,
    requireScope,
} from "@/lib/auth-request";
import { isHostedLockedOut } from "@/lib/entitlements";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    enforceV1AuthenticatedRateLimit,
    enforceV1IpRateLimit,
    enforceV1WriteRateLimit,
} from "@/lib/v1/rate-limit";

/** Largest JSON body a v1 write accepts. */
export const V1_MAX_WRITE_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Gate a v1 write: per-IP and per-token read buckets, authentication, the
 * `write` scope, the per-token write bucket, and the hosted lockout.
 * Returns the 429 response to send when a bucket is exhausted.
 */
export async function authorizeV1Write(
    request: Request,
): Promise<AuthenticatedRequest | Response> {
    const ipLimitResponse = await enforceV1IpRateLimit(request);
    if (ipLimitResponse) return ipLimitResponse;

    const authn = await authenticateRequest(request);
    if (!authn) {
        throw new AppError(ErrorCode.UNAUTHORIZED, "Unauthorized", 401);
    }

    const authLimitResponse = await enforceV1AuthenticatedRateLimit(authn);
    if (authLimitResponse) return authLimitResponse;

    requireScope(authn, "write");

    const writeLimitResponse = await enforceV1WriteRateLimit(authn);
    if (writeLimitResponse) return writeLimitResponse;

    if (await isHostedLockedOut(authn.user.id)) {
        throw new AppError(
            ErrorCode.ACCOUNT_LOCKED,
            "Your hosted plan has lapsed.",
            403,
        );
    }

    return authn;
}

/**
 * Read and validate a JSON body, refusing more than `maxBytes` without
 * buffering the excess.
 */
export async function parseV1JsonBody<T extends z.ZodType>(
    request: Request,
    schema: T,
    maxBytes = V1_MAX_WRITE_BODY_BYTES,
): Promise<z.output<T>> {
    const tooLarge = () =>
        new AppError(ErrorCode.INVALID_INPUT, "Request body too large", 413, {
            maxBytes,
        });

    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

    const chunks: Uint8Array[] = [];
    let received = 0;
    if (request.body) {
        const reader = request.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes) {
                await reader.cancel();
                throw tooLarge();
            }
            chunks.push(value);
        }
    }

    let raw: unknown;
    try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Request body must be JSON",
            400,
        );
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
            {
                issues: parsed.error.flatten(),
            },
        );
    }
    return parsed.data;
}

/** Throw `404 RECORDING_NOT_FOUND` unless the user owns a live recording `id`. */
export async function assertV1RecordingExists(
    userId: string,
    id: string,
): Promise<void> {
    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, userId),
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
}

/** The `410` a write answers when the recording was deleted mid-write. */
export function recordingDeletedError(id: string): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Recording was deleted", 410, {
        id,
    });
}
