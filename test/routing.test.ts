// The SDK's Routing: a flow's trigger leaves an item for others by the people
// on it, as GitHub's assignee: and review-requested: qualifiers do, with its
// filters in the flow's settings; the engine only reads the reason.

import { Implement, Review, Routing, Settings } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import YAML from "yaml";

import { effect } from "./effect-test.ts";
import { item, makeFake, onFake } from "./sdk-fakes.ts";

// The fake's GitHub is chernabog-bot.
const routedAs = (input: Settings.FlowSettings["Service"]["input"], people: Routing.People) =>
  onFake(
    makeFake("approve"),
    Routing.leftFor(people).pipe(Effect.provideService(Settings.FlowSettings, { input })),
  );

describe("routing by assignee and requested reviewer", () => {
  effect("without a filter, every item is this persona's", () =>
    Effect.gen(function* () {
      expect(yield* routedAs({}, { assignees: ["alice"] })).toEqual(Option.none());

      // As config.yaml writes it: `assignee: null`, which clears the team's.
      const cleared = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
        YAML.parse("assignee: null"),
      );

      expect(yield* routedAs(cleared, { assignees: ["alice"] })).toEqual(Option.none());
    }),
  );

  effect("@me is the persona, none is nobody, and a login is that person, in any case", () =>
    Effect.gen(function* () {
      const mine = { assignee: ["@me", "none"] };

      expect(yield* routedAs(mine, { assignees: ["Chernabog-Bot"] })).toEqual(Option.none());
      expect(yield* routedAs(mine, { assignees: [] })).toEqual(Option.none());
      expect(yield* routedAs(mine, {})).toEqual(Option.none());
      expect(yield* routedAs(mine, { assignees: ["alice"] })).toEqual(
        Option.some("assignee: alice"),
      );
      expect(yield* routedAs({ assignee: "ALICE" }, { assignees: ["bob", "alice"] })).toEqual(
        Option.none(),
      );
    }),
  );

  effect("requested reviewers route pull requests, and every filter set must pass", () =>
    Effect.gen(function* () {
      expect(yield* routedAs({ reviewRequested: "@me" }, { reviewers: ["alice"] })).toEqual(
        Option.some("review requested: alice"),
      );
      expect(
        yield* routedAs(
          { assignee: "@me", reviewRequested: "@me" },
          { assignees: [], reviewers: ["chernabog-bot"] },
        ),
      ).toEqual(Option.some("assignee: none; review requested: chernabog-bot"));
    }),
  );

  effect("the SDK's issue and pull request items carry the reason, for the engine to leave", () =>
    Effect.gen(function* () {
      const fake = makeFake("approve");
      const input = { assignee: "@me" };

      const routed = (routing: ReturnType<typeof Routing.route>) =>
        onFake(fake, routing.pipe(Effect.provideService(Settings.FlowSettings, { input })));

      const issue = yield* routed(
        Implement.routed(
          {
            number: 4,
            title: "Theirs",
            body: "",
            url: "",
            labels: [],
            assignees: ["alice"],
            createdAt: "2026-10-01T00:00:00Z",
          },
          item("issue-4"),
        ),
      );

      expect(issue).toEqual({ ...item("issue-4"), elsewhere: "assignee: alice" });

      const pull = yield* routed(
        Review.routed(
          {
            number: 7,
            title: "Ours",
            body: "",
            url: "",
            state: "open",
            headRef: "auto/issue-3",
            headSha: "abc1234def",
            baseRef: "main",
            labels: [],
            author: "alice",
            assignees: ["chernabog-bot"],
            requestedReviewers: [],
          },
          item("pr-7"),
        ),
      );

      expect(pull).toEqual(item("pr-7"));
    }),
  );
});
