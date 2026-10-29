import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { Checkout } from "../domain/enrolled-repo/checkout.value-object.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { TeamFlows } from "../domain/enrolled-repo/team-flows.value-object.ts";
import { CheckoutsClientFake } from "../infrastructure/clients/checkouts.client-fake.ts";
import { ViewerClientFake } from "../infrastructure/clients/viewer.client-fake.ts";
import { EnrolledReposRepositoryFake } from "../infrastructure/repositories/enrolled-repos.repository-fake.ts";
import { planEnrollmentUseCase } from "./plan-enrollment.use-case.ts";

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

describe("planEnrollmentUseCase", () => {
  effect(
    "offers each persona the checkout's flows, with the team's defaults and its current ones",
    () =>
      Effect.gen(function* () {
        const plan = yield* planEnrollmentUseCase(
          "/src/demo/sub",
          Option.none(),
          offered(["alice", "bob"]),
        );

        expect([plan.repo, plan.root, plan.logins, plan.currentPersonas]).toEqual([
          demo,
          "/src/demo",
          ["alice", "bob"],
          Option.some(["bob"]),
        ]);
        expect(plan.personas.map((own) => own.persona)).toEqual([
          Option.some("alice"),
          Option.some("bob"),
        ]);
        expect(plan.personas.map((own) => own.defaults)).toEqual([
          ["implement"],
          ["implement", "review"],
        ]);
        expect(plan.personas.map((own) => own.current)).toEqual([
          Option.none(),
          Option.some(["review"]),
        ]);
      }).pipe(Effect.provide(machineOf([entry({ personas: { bob: { flows: { review: {} } } } })]))),
  );

  effect("without personas, asks GitHub who the implicit one is, for the team's runners", () =>
    Effect.gen(function* () {
      const plan = yield* planEnrollmentUseCase("/src/demo", Option.none(), offered([]));

      expect(plan.personas.map((own) => [own.persona, own.defaults])).toEqual([
        [Option.none(), ["implement"]],
      ]);
      expect(plan.personas[0].offers[2].teamOff).toEqual(
        Option.some("not a runner (runners: bob; this machine is carol)"),
      );
    }).pipe(Effect.provide(machineOf([]))),
  );

  effect("refuses a path that isn't in a checkout", () =>
    Effect.gen(function* () {
      expect(
        (yield* Effect.flip(planEnrollmentUseCase("/tmp", Option.none(), offered([]))))._tag,
      ).toBe("CheckoutUnreadable");
    }).pipe(Effect.provide(machineOf([]))),
  );
});
