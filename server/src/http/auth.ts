import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";

/**
 * Constant-time string comparison: a wrong token takes the same time to
 * reject regardless of how many leading characters match. Buffers of
 * different lengths return `false` immediately instead of calling
 * `timingSafeEqual` (which throws on a length mismatch); the token length
 * is not secret, so this short-circuit adds no meaningful signal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

const BEARER_SCHEME = "bearer";

/**
 * Extract the credentials from an `Authorization` header whose scheme is
 * `Bearer`, matched case-insensitively per RFC 7235 §2.1 (auth-scheme
 * names are case-insensitive, so `bearer`, `BEARER`, `Bearer` are all
 * accepted). Returns `null` for a missing header, a different scheme,
 * or a header with no scheme/credentials separator.
 */
function parseBearerToken(header: string | undefined | null): string | null {
  if (!header) {
    return null;
  }

  const spaceIndex = header.indexOf(" ");
  if (spaceIndex === -1) {
    return null;
  }

  const scheme = header.slice(0, spaceIndex);
  if (scheme.toLowerCase() !== BEARER_SCHEME) {
    return null;
  }

  // Only the first space separates scheme from credentials; anything
  // after it (including a stray extra space) is part of the token, so
  // an accidental double space never matches a real token by accident.
  return header.slice(spaceIndex + 1);
}

/**
 * Hono middleware requiring `Authorization: Bearer <token>` (scheme
 * matched case-insensitively) to carry `expectedToken` exactly. Responds
 * 401 on a missing header, an unparseable or non-Bearer header, or a
 * mismatched token.
 */
export function bearerAuth(expectedToken: string) {
  return createMiddleware(async (c, next) => {
    const token = parseBearerToken(c.req.header("Authorization"));

    if (token === null || !constantTimeEqual(token, expectedToken)) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }

    await next();
  });
}
