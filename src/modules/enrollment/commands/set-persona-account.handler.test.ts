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
import { setPersonaAccountHandler } from "./set-persona-account.handler.ts";

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

const accounts = offered(
  [],
  [
    { name: "work", agent: "claude" },
    { name: "personal", agent: "claude" },
    { name: "codex", agent: "codex" },
  ],
);

describe("setPersonaAccountHandler", () => {
  effect("picks a persona's account and a role's, and refuses ones that clash", () =>
    Effect.gen(function* () {
      yield* setPersonaAccountHandler({
        name: "demo",
        persona: Option.none(),
        role: Option.none(),
        account: Option.some("personal"),
        offered: accounts,
      });
      yield* setPersonaAccountHandler({
        name: "demo",
        persona: Option.none(),
        role: Option.some("reviewer"),
        account: Option.some("codex"),
        offered: accounts,
      });

      expect((yield* stored)[0].defaults).toEqual({
        account: "personal",
        roles: { reviewer: "codex" },
      });

      const clash = yield* Effect.flip(
        setPersonaAccountHandler({
          name: "demo",
          persona: Option.none(),
          role: Option.some("author"),
          account: Option.some("work"),
          offered: accounts,
        }),
      );

      expect(clash.message).toContain("a claude account like the persona's own (personal)");
      expect((yield* stored)[0].defaults.roles).toEqual({ reviewer: "codex" });
    }).pipe(Effect.provide(machineOf([entry()]))),
  );
});
