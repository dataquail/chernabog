import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import {
  fakeInbox,
  NotificationsClientFake,
} from "../infrastructure/clients/notifications.client-fake.ts";
import { pollNotificationsHandler } from "./poll-notifications.handler.ts";

const inbox = fakeInbox({
  notifications: {
    bob: [
      {
        repo: "Acme/Demo",
        item: Option.some(73),
        reason: "review_requested",
        updatedAt: "2026-10-27T12:02:00Z",
      },
      {
        repo: "acme/other",
        item: Option.some(4),
        reason: "author",
        updatedAt: "2026-10-27T12:03:00Z",
      },
      {
        repo: "acme/demo",
        item: Option.some(70),
        reason: "author",
        updatedAt: "2026-10-27T11:00:00Z",
      },
    ],
  },
  failing: { carol: "GitHub refused carol's token" },
});

const cursor = { lastModified: Option.none<string>(), since: "2026-10-27T12:00:00Z" };

describe("pollNotificationsHandler", () => {
  effect("hears what changed since the cursor about enrolled repos, and moves the cursor on", () =>
    Effect.gen(function* () {
      const poll = yield* pollNotificationsHandler({
        persona: Option.some("bob"),
        cursor,
        repos: ["acme/demo"],
      });

      expect(poll.news.map((news) => news.cause)).toEqual([
        "notification: review_requested on #73",
      ]);
      expect(poll.news.map((news) => news.item)).toEqual([Option.some(73)]);
      expect(poll.since).toBe("2026-10-27T12:03:00Z");
      expect(poll.pollIntervalMs).toBe(60_000);

      const again = yield* pollNotificationsHandler({
        persona: Option.some("bob"),
        cursor: { ...cursor, since: poll.since },
        repos: ["acme/demo"],
      });

      expect(again.news).toEqual([]);
    }).pipe(Effect.provide(NotificationsClientFake(inbox))),
  );

  effect("a poll that fails says why", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        pollNotificationsHandler({ persona: Option.some("carol"), cursor, repos: ["acme/demo"] }),
      );

      expect(failed.reason).toBe("GitHub refused carol's token");
    }).pipe(Effect.provide(NotificationsClientFake(inbox))),
  );
});
