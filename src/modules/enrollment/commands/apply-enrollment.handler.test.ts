import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { Checkout } from "../domain/enrolled-repo/checkout.value-object.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { TeamFlows } from "../domain/enrolled-repo/team-flows.value-object.ts";
import { EnrolledReposRepository } from "../domain/ports/repositories/enrolled-repos.repository.ts";
import { CheckoutsClientFake } from "../infrastructure/clients/checkouts.client-fake.ts";
import { ViewerClientFake } from "../infrastructure/clients/viewer.client-fake.ts";
import { EnrolledReposRepositoryFake } from "../infrastructure/repositories/enrolled-repos.repository-fake.ts";
import { applyEnrollmentHandler } from "./apply-enrollment.handler.ts";

const demo = RepoSlug.make("dataquail/demo");

const team = TeamFlows.make({
  agent: Option.none(),
  runners: Option.none(),
  flows: { fix: { enabled: false }, review: { runners: ["bob"] } },
});

const here = Checkout.make({
  root: "/src/demo",
  repo: demo,
  flows: ["fix", "implement", "review"],
  team,
});

const entry = (fields: Partial<ConstructorParameters<typeof EnrolledRepoRoot>[0]> = {}) =>
  EnrolledRepoRoot.make({ repo: demo, path: "/src/demo", defaults: {}, paused: false, ...fields });

const stored = EnrolledReposRepository.use((repository) => repository.findAll);

const machineOf = (repos: ReadonlyArray<EnrolledRepoRoot>, present: ReadonlyArray<string> = []) =>
  Layer.mergeAll(
    EnrolledReposRepositoryFake(repos),
    CheckoutsClientFake([here], present),
    ViewerClientFake(Option.some("carol")),
  );

const offered = (
  personas: ReadonlyArray<string>,
  accounts = [{ name: "work", agent: "claude" }],
) => ({
  personas,
  accounts,
});

const unanswered = {
  personas: Option.none(),
  flows: Option.none(),
  accounts: [],
  asked: [],
};

describe("applyEnrollmentHandler", () => {
  effect("enrolls a new checkout with the defaults, on the repo's entry, in one write", () =>
    Effect.gen(function* () {
      const enrolled = yield* applyEnrollmentHandler({
        path: "/src/demo",
        name: Option.none(),
        offered: offered([]),
        answers: unanswered,
      });

      expect([enrolled.added, enrolled.name, enrolled.chosen]).toEqual([
        true,
        "demo",
        [{ persona: Option.none(), flows: ["implement"], account: Option.none(), accounts: [] }],
      ]);
      expect((yield* stored).map((repo) => [repo.path, repo.defaults])).toEqual([
        ["/src/demo", { flows: { implement: {} } }],
      ]);
    }).pipe(Effect.provide(machineOf([]))),
  );

  effect("each of several personas gets its own entry, from what was asked of each", () =>
    Effect.gen(function* () {
      yield* applyEnrollmentHandler({
        path: "/src/demo",
        name: Option.none(),
        offered: offered(["alice", "bob"]),
        answers: {
          ...unanswered,
          personas: Option.some(["alice", "bob"]),
          flows: Option.some({ defaults: true }),
          asked: [{ persona: Option.some("bob"), flows: Option.some(["fix"]), accounts: [] }],
        },
      });

      expect((yield* stored)[0].personas).toEqual({
        alice: { flows: { implement: {} } },
        bob: { flows: { fix: {} } },
      });
    }).pipe(Effect.provide(machineOf([]))),
  );

  effect("re-enrolling keeps the entry's settings and its listed flows' settings", () =>
    Effect.gen(function* () {
      const enrolled = yield* applyEnrollmentHandler({
        path: "/src/demo",
        name: Option.none(),
        offered: offered([]),
        answers: { ...unanswered, flows: Option.some({ flows: ["implement", "fix"] }) },
      });

      expect(enrolled.added).toBe(false);
      expect((yield* stored)[0].defaults).toEqual({
        launcher: "tmux",
        flows: { implement: { schedule: "5 * * * *" }, fix: {} },
      });
    }).pipe(
      Effect.provide(
        machineOf([
          entry({
            path: "/old/demo",
            defaults: { launcher: "tmux", flows: { implement: { schedule: "5 * * * *" } } },
          }),
        ]),
      ),
    ),
  );

  effect("several personas and none chosen, nor any before, is refused", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        applyEnrollmentHandler({
          path: "/src/demo",
          name: Option.none(),
          offered: offered(["alice", "bob"]),
          answers: unanswered,
        }),
      );

      expect(refused.message).toBe(
        "machine config has several GitHub personas (alice, bob); choose this repo's with --persona",
      );
      expect(yield* stored).toEqual([]);
    }).pipe(Effect.provide(machineOf([]))),
  );
});
