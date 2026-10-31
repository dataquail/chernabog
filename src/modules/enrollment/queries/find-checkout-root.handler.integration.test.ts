import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effectAtHomeWith } from "../../../../test/effect-test.ts";
import { Exec, execOk } from "../../../platform/exec.ts";
import { CheckoutsClientLive } from "../infrastructure/clients/checkouts.client-live.ts";
import { ViewerClientFake } from "../infrastructure/clients/viewer.client-fake.ts";
import { EnrolledReposRepositoryLive } from "../infrastructure/repositories/enrolled-repos.repository-live.ts";
import { findCheckoutRootHandler } from "./find-checkout-root.handler.ts";

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

// Machine config through the live repository, checkouts through git; GitHub,
// which the viewer asks, keeps its fake.
const machine = Layer.mergeAll(
  EnrolledReposRepositoryLive,
  CheckoutsClientLive,
  ViewerClientFake(Option.some("carol")),
);

// git runs for real.
const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

describe("findCheckoutRootHandler", () => {
  effect("is the root of the checkout a path is in", () =>
    Effect.gen(function* () {
      const root = yield* scratchCheckout;

      expect((yield* findCheckoutRootHandler({ path: `${root}/sub/lib` })).root).toBe(root);
      expect((yield* Effect.flip(findCheckoutRootHandler({ path: yield* elsewhere })))._tag).toBe(
        "CheckoutUnreadable",
      );
    }).pipe(Effect.provide(machine)),
  );
});
