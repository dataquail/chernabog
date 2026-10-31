// The writes a capability declares (#205): the engine fences and reports each
// write a port declares, by its declaration alone, and names none of them; a
// port of a test's own is fenced and reported the moment it is declared; and
// a port method left undeclared doesn't compile.

import { Capabilities, Git, GitHub } from "@chernabog/sdk";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { fencing, reportingChanges } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import { makeFake, onFake } from "./sdk-fakes.ts";

// The fake's GitHub and Git, as the engine hands them to a run.
const fakeContext = onFake(makeFake("approve"), Effect.context<GitHub | Git>());

type Seen = { readonly what: string; readonly item: Option.Option<number> };

describe("fencing", () => {
  effect("checks the fence before every write GitHub and Git declare, and never for a read", () =>
    Effect.gen(function* () {
      const fenced: Array<string> = [];

      const context = fencing(yield* fakeContext, (what) =>
        Effect.sync(() => {
          fenced.push(what);
        }),
      );

      yield* Effect.gen(function* () {
        const github = yield* GitHub;
        yield* github.issue(3);
        yield* github.addSubIssue(3, 5);
        yield* github.addBlockedBy(5, 4);
        yield* github.createIssue({ title: "a task", body: "", labels: [] });
        yield* github.deleteBranch("auto/issue-3");
        yield* github.request("GET", "/repos/dataquail/demo", Option.none());
        yield* github.request("POST", "/repos/dataquail/demo/forks", Option.none());
        yield* (yield* Git).push(".", "auto/issue-3");
      }).pipe(Effect.provideContext(context));

      expect(fenced).toEqual([
        "adding sub-issue #5",
        "marking blocked by #4",
        "creating an issue",
        "deleting auto/issue-3",
        "POST /repos/dataquail/demo/forks",
        "pushing auto/issue-3",
      ]);
    }),
  );
});

describe("reportingChanges", () => {
  effect("reports every write GitHub declares once made, with the item it changed", () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = [];

      const context = reportingChanges(yield* fakeContext, (what, item) =>
        Effect.sync(() => {
          seen.push({ what, item });
        }),
      );

      const created = yield* Effect.gen(function* () {
        const github = yield* GitHub;
        yield* github.comments(3);
        const made = yield* github.createIssue({ title: "a task", body: "", labels: [] });
        yield* github.addSubIssue(3, made.number);
        yield* github.removeBlockedBy(made.number, 4);

        return made;
      }).pipe(Effect.provideContext(context));

      expect(seen).toEqual([
        { what: "issue created", item: Option.some(created.number) },
        { what: `sub-issue #${created.number} added`, item: Option.some(3) },
        { what: "no longer blocked by #4", item: Option.some(created.number) },
      ]);
    }),
  );
});

// A capability no engine has heard of: a ticket tracker.
class Tracker extends Context.Service<
  Tracker,
  {
    ticket(number: number): Effect.Effect<string>;
    post(ticket: number, text: string): Effect.Effect<void>;
  }
>()("test/Tracker") {}

const TrackerCapability = Capabilities.declare(
  Tracker,
  (tracker, guard) => ({
    post: guard(tracker.post, (ticket) =>
      Capabilities.write(`posting on ${ticket}`, "posted", Option.some(ticket)),
    ),
  }),
  { ticket: "read" },
);

describe("a port of its own", () => {
  effect("is fenced and reported by being declared", () =>
    Effect.gen(function* () {
      const posted: Array<string> = [];
      const fenced: Array<string> = [];
      const seen: Array<Seen> = [];

      const context = Context.make(
        Tracker,
        Tracker.of({
          ticket: (number) => Effect.succeed(`ticket ${number}`),
          post: (_ticket, text) =>
            Effect.sync(() => {
              posted.push(text);
            }),
        }),
      );

      const guarded = fencing(
        reportingChanges(
          context,
          (what, item) =>
            Effect.sync(() => {
              seen.push({ what, item });
            }),
          [TrackerCapability],
        ),
        (what) =>
          Effect.sync(() => {
            fenced.push(what);
          }),
        [TrackerCapability],
      );

      yield* Effect.gen(function* () {
        const tracker = yield* Tracker;
        yield* tracker.ticket(9);
        yield* tracker.post(9, "done");
      }).pipe(Effect.provideContext(guarded));

      expect(posted).toEqual(["done"]);
      expect(fenced).toEqual(["posting on 9"]);
      expect(seen).toEqual([{ what: "posted", item: Option.some(9) }]);
    }),
  );

  effect("can't leave a method undeclared", () =>
    Effect.sync(() => {
      // @ts-expect-error -- `post` is neither declared a write nor anything else, which is what this test shows doesn't compile.
      const undeclared = Capabilities.declare(Tracker, () => ({}), { ticket: "read" });

      expect(Object.keys(undeclared.others)).toEqual(["ticket"]);
    }),
  );
});
