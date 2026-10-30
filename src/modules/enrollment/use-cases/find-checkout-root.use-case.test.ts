import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { Checkout } from "../domain/enrolled-repo/checkout.value-object.ts";
import { type EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { TeamFlows } from "../domain/enrolled-repo/team-flows.value-object.ts";
import { CheckoutsClientFake } from "../infrastructure/clients/checkouts.client-fake.ts";
import { ViewerClientFake } from "../infrastructure/clients/viewer.client-fake.ts";
import { EnrolledReposRepositoryFake } from "../infrastructure/repositories/enrolled-repos.repository-fake.ts";
import { findCheckoutRootUseCase } from "./find-checkout-root.use-case.ts";

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

const machineOf = (repos: ReadonlyArray<EnrolledRepoRoot>, present: ReadonlyArray<string> = []) =>
  Layer.mergeAll(
    EnrolledReposRepositoryFake(repos),
    CheckoutsClientFake([here], present),
    ViewerClientFake(Option.some("carol")),
  );

describe("findCheckoutRootUseCase", () => {
  effect("is the root of the checkout a path is in", () =>
    Effect.gen(function* () {
      expect((yield* findCheckoutRootUseCase("/src/demo/src/lib")).root).toBe("/src/demo");
      expect((yield* Effect.flip(findCheckoutRootUseCase("/tmp")))._tag).toBe("CheckoutUnreadable");
    }).pipe(Effect.provide(machineOf([]))),
  );
});
