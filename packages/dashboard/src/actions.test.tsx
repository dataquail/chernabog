// What the page posts for each action on a run, and what it makes of the
// daemon's answer: its result, or its Refusal, as it is, and no retry.

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { it } from "effect-bun-test";

import { CancelRequest, RunRequest, TickResult } from "#daemon/protocol";

import { type Action, attachLine, perform, requestFor } from "./actions.ts";

type Asked = {
  readonly url: string;
  readonly method: string;
  readonly type: string;
  readonly text: string;
};

// A daemon that answers every request with `reply`, and what it was asked.
const daemonAnswering = (reply: () => Response) => {
  const asked: Array<Asked> = [];

  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request));
      const text = yield* Effect.promise(() => web.text());

      asked.push({
        url: url.href,
        method: request.method,
        type: web.headers.get("content-type") ?? "",
        text,
      });

      return HttpClientResponse.fromWeb(request, reply());
    }),
  );

  return { asked, client };
};

const nobodyListening = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
    }),
  ),
);

const RUN_ID = "5714245a-211c-4f0d-8ce1-74b725bac0d6";

const runNow: Action = {
  kind: "run",
  repo: "api",
  flow: "implement",
  item: Option.none(),
  persona: Option.none(),
};

const decodeRun = Schema.decodeUnknownSync(Schema.toCodecJson(RunRequest));
const decodeCancel = Schema.decodeUnknownSync(Schema.toCodecJson(CancelRequest));

const decodeRunText = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(RunRequest)),
);

const encodeTick = Schema.encodeSync(Schema.toCodecJson(TickResult));
const byId = (asked: string) => CancelRequest.fields.target.cases.ById.make({ asked });

describe("each action's request", () => {
  test("run now posts /api/run with the body `chernabog run` sends: no item, no persona", () => {
    const request = requestFor(runNow);

    expect(request.path).toBe("/api/run");
    expect(decodeRun(request.body)).toEqual({
      repo: "api",
      flow: "implement",
      item: Option.none(),
    });
  });

  test("run now names the item and the persona picked", () => {
    const request = requestFor({
      ...runNow,
      item: Option.some("#73"),
      persona: Option.some("bob"),
    });

    expect(decodeRun(request.body)).toEqual({
      repo: "api",
      flow: "implement",
      item: Option.some("#73"),
      persona: "bob",
    });
  });

  test("cancel posts /api/cancel by id, by the dashboard, closing its sessions if asked", () => {
    const keep = requestFor({ kind: "cancel", runId: RUN_ID, closeSessions: false });
    const close = requestFor({ kind: "cancel", runId: RUN_ID, closeSessions: true });

    expect(keep.path).toBe("/api/cancel");
    expect(decodeCancel(keep.body)).toEqual({
      target: byId(RUN_ID),
      by: "dashboard",
      closeSessions: false,
    });
    expect(decodeCancel(close.body).closeSessions).toBe(true);
    expect(decodeCancel(close.body).by).toBe("dashboard");
  });

  test("open in launcher posts the run's attach route, with an empty JSON body", () => {
    expect(requestFor({ kind: "attach", runId: RUN_ID })).toEqual({
      path: `/api/runs/${RUN_ID}/attach`,
      body: {},
    });
  });

  test("copy gives the command that attaches in a terminal", () => {
    expect(attachLine(RUN_ID)).toBe(`chernabog attach ${RUN_ID}`);
  });
});

describe("performing an action", () => {
  it.live("posts JSON to the page's origin and says what started", () =>
    Effect.gen(function* () {
      const { asked, client } = daemonAnswering(() =>
        Response.json(encodeTick({ started: [RUN_ID], skipped: Option.none() })),
      );

      const outcome = yield* perform("http://daemon", runNow).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(asked.map(({ method, type, url }) => ({ method, type, url }))).toEqual([
        { url: "http://daemon/api/run", method: "POST", type: "application/json" },
      ]);
      expect(asked.map((request) => decodeRunText(request.text))).toEqual([
        { repo: "api", flow: "implement", item: Option.none() },
      ]);
      expect(outcome).toEqual({ kind: "done", message: "started 5714245a" });
    }),
  );

  it.live("says why a run now started nothing", () =>
    Effect.gen(function* () {
      const { client } = daemonAnswering(() =>
        Response.json(encodeTick({ started: [], skipped: Option.some("nothing is queued") })),
      );

      const outcome = yield* perform("http://daemon", runNow).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(outcome).toEqual({ kind: "done", message: "started nothing: nothing is queued" });
    }),
  );

  it.live("a cancel the daemon did says so", () =>
    Effect.gen(function* () {
      const { client } = daemonAnswering(() => Response.json({}));

      const outcome = yield* perform("http://daemon", {
        kind: "cancel",
        runId: RUN_ID,
        closeSessions: false,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(outcome).toEqual({ kind: "done", message: "cancelled" });
    }),
  );

  it.live("an open in launcher says where it opened", () =>
    Effect.gen(function* () {
      const { client } = daemonAnswering(() =>
        Response.json({ launcher: "tmux", sessionId: "abc" }),
      );

      const outcome = yield* perform("http://daemon", { kind: "attach", runId: RUN_ID }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(outcome).toEqual({ kind: "done", message: "opened in tmux" });
    }),
  );

  it.live("a refusal is the daemon's message, asked once", () =>
    Effect.gen(function* () {
      const actions: ReadonlyArray<[Action, string]> = [
        [runNow, "api runs implement as bob, carol; name one with --as"],
        [
          { kind: "cancel", runId: RUN_ID, closeSessions: true },
          "no run in flight matches 5714245a",
        ],
        [{ kind: "attach", runId: RUN_ID }, "its session runs headless: copy the command instead"],
      ];

      for (const [action, error] of actions) {
        const { asked, client } = daemonAnswering(() => Response.json({ error }, { status: 409 }));

        const outcome = yield* perform("http://daemon", action).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );

        expect(outcome).toEqual({ kind: "refused", message: error });
        expect(asked).toHaveLength(1);
      }
    }),
  );

  it.live("an answer that isn't a Refusal says the status it came with", () =>
    Effect.gen(function* () {
      const { client } = daemonAnswering(() => new Response("oops", { status: 502 }));

      const outcome = yield* perform("http://daemon", runNow).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(outcome).toEqual({ kind: "refused", message: "the daemon answered 502" });
    }),
  );

  it.live("a daemon that isn't there is refused, once", () =>
    Effect.gen(function* () {
      const outcome = yield* perform("http://daemon", runNow).pipe(
        Effect.provideService(HttpClient.HttpClient, nobodyListening),
      );

      expect(outcome.kind).toBe("refused");
      expect(outcome.message).toContain("couldn't reach the daemon");
    }),
  );
});
