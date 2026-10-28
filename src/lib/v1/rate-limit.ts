import { NextResponse } from "next/server";
import type { AuthenticatedRequest } from "@/lib/auth-request";
import { ErrorCode } from "@/lib/errors";
import {
    consumeRateLimitBucket,
    getClientIp,
    type RateLimitResult,
} from "@/lib/rate-limit";

const WINDOW_MS = 60_000;
const IP_LIMIT = 1_200;
const AUTHENTICATED_LIMIT = 600;
const WRITE_LIMIT = 60;

export { getClientIp };

function rateLimitResponse(result: RateLimitResult): NextResponse {
    const retryAfter = Math.max(
        1,
        Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
    );
    const resetAt = Math.ceil(result.resetAt.getTime() / 1000);

    return NextResponse.json(
        {
            error: "Rate limit exceeded",
            code: ErrorCode.RATE_LIMITED,
            details: {
                retryAfter,
                limit: result.limit,
                remaining: result.remaining,
                resetAt,
            },
        },
        {
            status: 429,
            headers: {
                "Retry-After": retryAfter.toString(),
                "X-RateLimit-Limit": result.limit.toString(),
                "X-RateLimit-Remaining": result.remaining.toString(),
                "X-RateLimit-Reset": resetAt.toString(),
            },
        },
    );
}

export async function enforceV1IpRateLimit(
    request: Request,
): Promise<NextResponse | null> {
    const result = await consumeRateLimitBucket(
        `v1:ip:${getClientIp(request)}`,
        {
            limit: IP_LIMIT,
            windowMs: WINDOW_MS,
        },
    );
    return result.allowed ? null : rateLimitResponse(result);
}

function rateLimitIdentity(authn: AuthenticatedRequest): string {
    return authn.via === "api-key" && authn.apiKeyId
        ? `api-key:${authn.apiKeyId}`
        : `user:${authn.user.id}`;
}

export async function enforceV1AuthenticatedRateLimit(
    authn: AuthenticatedRequest,
): Promise<NextResponse | null> {
    const result = await consumeRateLimitBucket(
        `v1:auth:${rateLimitIdentity(authn)}`,
        {
            limit: AUTHENTICATED_LIMIT,
            windowMs: WINDOW_MS,
        },
    );
    return result.allowed ? null : rateLimitResponse(result);
}

/** Extra per-token bucket for v1 writes, consumed on top of the read buckets. */
export async function enforceV1WriteRateLimit(
    authn: AuthenticatedRequest,
): Promise<NextResponse | null> {
    const result = await consumeRateLimitBucket(
        `v1:write:${rateLimitIdentity(authn)}`,
        {
            limit: WRITE_LIMIT,
            windowMs: WINDOW_MS,
        },
    );
    return result.allowed ? null : rateLimitResponse(result);
}
