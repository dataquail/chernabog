import { type Json } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { type Persona } from "../../../../kernel/persona.value-object.ts";
import { GitHubApi } from "../../../../platform/github-api.ts";
import { NotificationsClient } from "../../domain/ports/clients/notifications.client.ts";
import { NotificationsClientLive } from "./notifications.client-live.ts";

type Asked = {
  readonly persona: Persona;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
};

// GitHub answering every request with one response, as each persona, and
// recording what was asked.
const answering = (
  asked: Array<Asked>,
  status: number,
  body: Option.Option<Json>,
  headers: Readonly<Record<string, string>> = {},
) =>
  NotificationsClientLive((persona) =>
    Layer.succeed(
      GitHubApi,
      GitHubApi.of({
        request: (_method, path, _body, sent = {}) =>
          Effect.sync(() => {
            asked.push({ persona, path, headers: sent });

            return { status, body, nextUrl: Option.none(), headers };
          }),
      }),
    ),
  );

const poll = (lastModified: Option.Option<string>) =>
  NotificationsClient.use((client) =>
    client.poll(Option.some("bob"), lastModified, "2026-10-27T12:00:00Z"),
  );

const thread = {
  reason: "review_requested",
  updated_at: "2026-10-27T12:01:00Z",
  repository: { full_name: "acme/demo" },
  subject: { url: "https://api.github.com/repos/acme/demo/pulls/73" },
};

describe("NotificationsClientLive", () => {
  const asked: Array<Asked> = [];

  effect(
    "reads changed threads, read or not, as the persona, and keeps Last-Modified and the poll interval",
    () =>
      Effect.gen(function* () {
        const page = yield* poll(Option.none());

        expect(page.changed).toBe(true);
        expect(page.lastModified).toEqual(Option.some("Tue, 27 Oct 2026 12:01:00 GMT"));
        expect(Duration.toSeconds(page.pollInterval)).toBe(90);
        expect(page.notifications).toEqual([
          {
            repo: "acme/demo",
            item: Option.some(73),
            reason: "review_requested",
            updatedAt: thread.updated_at,
          },
          {
            repo: "acme/demo",
            item: Option.none(),
            reason: "mention",
            updatedAt: thread.updated_at,
          },
        ]);
        expect(asked[0]?.persona).toEqual(Option.some("bob"));
        expect(asked[0]?.path).toStartWith("/notifications?all=true&since=");
        expect(asked[0]?.headers).toEqual({});
      }).pipe(
        Effect.provide(
          answering(
            asked,
            200,
            Option.some([
              thread,
              {
                ...thread,
                reason: "mention",
                subject: { url: "https://api.github.com/repos/acme/demo/releases/5" },
              },
            ]),
            { "last-modified": "Tue, 27 Oct 2026 12:01:00 GMT", "x-poll-interval": "90" },
          ),
        ),
      ),
  );

  const unchanged: Array<Asked> = [];

  effect("asks If-Modified-Since, and a 304 is nothing changed", () =>
    Effect.gen(function* () {
      const since = Option.some("Tue, 27 Oct 2026 12:01:00 GMT");
      const page = yield* poll(since);

      expect(page.changed).toBe(false);
      expect(page.lastModified).toEqual(since);
      expect(Duration.toSeconds(page.pollInterval)).toBe(60);
      expect(unchanged[0]?.headers).toEqual({
        "If-Modified-Since": "Tue, 27 Oct 2026 12:01:00 GMT",
      });
    }).pipe(Effect.provide(answering(unchanged, 304, Option.none()))),
  );

  effect("a token that can't read notifications says how to fix it", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(poll(Option.none()));

      expect(failed.reason).toContain("can't read notifications");
      expect(failed.fix).toContain("gh auth switch --user bob");
    }).pipe(Effect.provide(answering([], 403, Option.some({ message: "no" })))),
  );
});
