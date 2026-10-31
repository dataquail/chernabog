import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effectAtHomeWith } from "../../../../test/effect-test.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { Exec, execOk } from "../../../platform/exec.ts";
import { EnrolledRepoRoot } from "../domain/enrolled-repo/enrolled-repo.root.ts";
import { EnrolledReposRepository } from "../domain/enrolled-repo/enrolled-repos.repository.ts";
import { CheckoutsClientLive } from "../infrastructure/clients/checkouts.client-live.ts";
import { ViewerClientFake } from "../infrastructure/clients/viewer.client-fake.ts";
import { EnrolledReposRepositoryLive } from "../infrastructure/repositories/enrolled-repos.repository-live.ts";
import { planEnrollmentHandler } from "./plan-enrollment.handler.ts";

const demo = RepoSlug.make("dataquail/demo");

const entry = (fields: Partial<ConstructorParameters<typeof EnrolledRepoRoot>[0]> = {}) =>
  EnrolledRepoRoot.make({ repo: demo, path: "/src/demo", defaults: {}, paused: false, ...fields });

const offered = (
  personas: ReadonlyArray<string>,
  accounts = [{ name: "work", agent: "claude" }],
) => ({
  personas,
  accounts,
});

// A checkout of dataquail/demo on the real filesystem, through git: three flows
// and the team's config, which turns fix off and gives review its runners.
const scratchCheckout = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-checkout-" });
  const git = (...args: ReadonlyArray<string>) => execOk("git", ["-C", root, ...args]);

  yield* git("init", "--quiet", "--initial-branch", "trunk");
  yield* git("remote", "add", "origin", "git@github.com:dataquail/demo.git");
  yield* fs.makeDirectory(`${root}/.chernabog/flows`, { recursive: true });
  yield* fs.makeDirectory(`${root}/sub/lib`, { recursive: true });
  yield* Effect.forEach(
    ["fix", "implement", "review"],
    (flow) => fs.writeFileString(`${root}/.chernabog/flows/${flow}.ts`, "export {};\n"),
    { discard: true },
  );
  yield* fs.writeFileString(
    `${root}/.chernabog/config.yaml`,
    "flows:\n  fix:\n    enabled: false\n  review:\n    runners: [bob]\n",
  );

  return yield* fs.realPath(root);
});

// A directory on the real filesystem that's in no checkout.
const elsewhere = FileSystem.FileSystem.use((fs) =>
  fs.makeTempDirectoryScoped({ prefix: "chernabog-none-" }),
);

// Machine config in the scratch home, holding `entries`, as the live repository writes it.
const enrol = (entries: ReadonlyArray<EnrolledRepoRoot>) =>
  EnrolledReposRepository.use((repository) =>
    Effect.forEach(entries, (saved) => repository.upsertOne(saved), { discard: true }),
  );

// Machine config through the live repository, checkouts through git; GitHub,
// which the viewer asks, keeps its fake.
const machine = Layer.mergeAll(
  EnrolledReposRepositoryLive,
  CheckoutsClientLive,
  ViewerClientFake(Option.some("carol")),
);

// git runs for real.
const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

describe("planEnrollmentHandler", () => {
  effect(
    "offers each persona the checkout's flows, with the team's defaults and its current ones",
    () =>
      Effect.gen(function* () {
        const root = yield* scratchCheckout;
        yield* enrol([entry({ path: root, personas: { bob: { flows: { review: {} } } } })]);

        const plan = yield* planEnrollmentHandler({
          path: `${root}/sub`,
          name: Option.none(),
          offered: offered(["alice", "bob"]),
        });

        expect([plan.repo, plan.root, plan.logins, plan.currentPersonas]).toEqual([
          demo,
          root,
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
      }).pipe(Effect.provide(machine)),
  );

  effect("without personas, asks GitHub who the implicit one is, for the team's runners", () =>
    Effect.gen(function* () {
      const plan = yield* planEnrollmentHandler({
        path: yield* scratchCheckout,
        name: Option.none(),
        offered: offered([]),
      });

      expect(plan.personas.map((own) => [own.persona, own.defaults])).toEqual([
        [Option.none(), ["implement"]],
      ]);
      expect(plan.personas[0].offers[2].teamOff).toEqual(
        Option.some("not a runner (runners: bob; this machine is carol)"),
      );
    }).pipe(Effect.provide(machine)),
  );

  effect("refuses a path that isn't in a checkout", () =>
    Effect.gen(function* () {
      expect(
        (yield* Effect.flip(
          planEnrollmentHandler({
            path: yield* elsewhere,
            name: Option.none(),
            offered: offered([]),
          }),
        ))._tag,
      ).toBe("CheckoutUnreadable");
    }).pipe(Effect.provide(machine)),
  );
});
