// The session API's tokens (ADR 24, "The token"). Each hub start draws a
// random 256-bit key, held only in its memory. A run's key is
// HMAC-SHA256(hub key, run id), which the hub gives the run's spoke; a
// session's token is base64url(HMAC-SHA256(run key, session id)), which the
// spoke mints as it writes the session's launch spec. The hub checks a
// request by deriving the token from the run and session the path names, so
// it stores none, and a token for one session is never another's.

import { createHmac, timingSafeEqual } from "node:crypto";

import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

// The address every hub's session API binds; an unsandboxed session reaches it here.
export const SESSION_API_LOOPBACK = "127.0.0.1";

// A hub's key: 32 random bytes, drawn once per hub start.
export const newHubKey = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;

  return yield* crypto.randomBytes(32);
}).pipe(Effect.orDie);

// A run's key, from its hub's.
export const runKey = (hubKey: Uint8Array, runId: string): Uint8Array =>
  new Uint8Array(createHmac("sha256", hubKey).update(runId, "utf8").digest());

// A session's token, from its run's key.
export const sessionToken = (key: Uint8Array, sessionId: string): string =>
  createHmac("sha256", key).update(sessionId, "utf8").digest("base64url");

// Whether a token is the one given, in time that says nothing of either.
export const sameSessionToken = (given: string, token: string) => {
  const encoder = new TextEncoder();
  const a = encoder.encode(given);
  const b = encoder.encode(token);

  return a.length === b.length && timingSafeEqual(a, b);
};

// A run's key as a spoke's hand-over carries it, and back.
export const encodeRunKey = (key: Uint8Array) => Buffer.from(key).toString("base64url");

export const decodeRunKey = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));
