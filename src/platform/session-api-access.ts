// How this process's agent sessions reach their hub's session API (ADR 24,
// "What a session is told"): the port the hub listens on, and the key of each
// run it hands out, from which a session's token is minted. A spoke has it
// from its hand-over, for its one run; a process that is its own hub (the
// foreground `run`, `rehearse`) from the listener it opened. A process
// without it, `ci run` under Actions, starts no interactive session.

import * as Context from "effect/Context";
import * as Option from "effect/Option";

import { SESSION_API_LOOPBACK, sessionToken } from "./session-token.ts";

export type SessionApiEndpoint = {
  readonly port: number;
  // The run's key; none for a run this process's hub didn't hand out.
  readonly runKey: (runId: string) => Option.Option<Uint8Array>;
};

export class SessionApiAccess extends Context.Service<SessionApiAccess, SessionApiEndpoint>()(
  "chernabog/SessionApiAccess",
) {}

// What a session's launch spec's env carries: its own routes' base URL, and
// its token, which goes only in an Authorization header.
export const SESSION_URL_ENV = "CHERNABOG_SESSION_URL";
export const SESSION_TOKEN_ENV = "CHERNABOG_SESSION_TOKEN";

// One session's base URL and token. Every session reaches the hub at
// loopback until a sandbox names another host (#716, #717).
export type SessionEndpoint = { readonly url: string; readonly token: string };

export const sessionEndpoint = (
  access: SessionApiEndpoint,
  runId: string,
  sessionId: string,
  host: string = SESSION_API_LOOPBACK,
): Option.Option<SessionEndpoint> =>
  Option.map(access.runKey(runId), (key) => ({
    url: `http://${host}:${access.port}/runs/${runId}/sessions/${sessionId}`,
    token: sessionToken(key, sessionId),
  }));
