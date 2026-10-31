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
import { listMovedReposHandler } from "./list-moved-repos.handler.ts";

const demo = RepoSlug.make("dataquail/demo");

const entry = (fields: Partial<ConstructorParameters<typeof EnrolledRepoRoot>[0]> = {}) =>
  EnrolledRepoRoot.make({ repo: demo, path: "/src/demo", defaults: {}, paused: false, ...fields });

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

describe("listMovedReposHandler", () => {
  effect("lists the repo's entries whose checkout is gone, with the name each was given", () =>
    Effect.gen(function* () {
      const root = yield* scratchCheckout;
      const kept = yield* elsewhere;
      const gone = `${kept}/gone`;
      yield* enrol([
        entry({ path: `${gone}/old`, name: "old" }),
        entry({ path: kept, name: "kept" }),
        entry({ repo: RepoSlug.make("dataquail/other"), path: `${gone}/other` }),
      ]);

      const { repos } = yield* listMovedReposHandler({ root });

      expect(repos.map((repo) => [repo.name, repo.named, repo.path])).toEqual([
        ["old", Option.some("old"), `${gone}/old`],
      ]);
    }).pipe(Effect.provide(machine)),
  );
});
