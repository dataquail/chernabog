import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effectAtHomeWith } from "../../../../../test/effect-test.ts";
import { Exec, execOk } from "../../../../platform/exec.ts";
import { CheckoutsClient } from "../../domain/ports/clients/checkouts.client.ts";
import { CheckoutsClientLive, slugFromRemote } from "./checkouts.client-live.ts";

// A checkout of dataquail/demo with two flows and the team's config, and a
// client over it.
const checkout = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-checkout-" });
  const git = (...args: ReadonlyArray<string>) => execOk("git", ["-C", root, ...args]);

  yield* git("init", "--quiet", "--initial-branch", "trunk");
  yield* git("remote", "add", "origin", "git@github.com:dataquail/demo.git");
  yield* fs.makeDirectory(`${root}/.chernabog/flows`, { recursive: true });
  yield* fs.makeDirectory(`${root}/src`, { recursive: true });
  yield* fs.writeFileString(`${root}/.chernabog/flows/review.ts`, "export {};\n");
  yield* fs.writeFileString(`${root}/.chernabog/flows/implement.ts`, "export {};\n");
  yield* fs.writeFileString(
    `${root}/.chernabog/config.yaml`,
    "agent: claude\nflows:\n  review:\n    agent: codex\n    runners: [bob]\n",
  );

  return { root: yield* fs.realPath(root), checkouts: yield* CheckoutsClient };
}).pipe(Effect.provide(CheckoutsClientLive));

// git runs for real.
const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

describe("CheckoutsClientLive", () => {
  test("the repo slug comes from an https or ssh origin", () => {
    expect(slugFromRemote("git@github.com:dataquail/goodbones.git\n")).toEqual(
      Option.some("dataquail/goodbones"),
    );
    expect(slugFromRemote("https://github.com/dataquail/goodbones")).toEqual(
      Option.some("dataquail/goodbones"),
    );
    expect(slugFromRemote("/tmp/origin.git")).toEqual(Option.none());
  });

  effect("finds the checkout's root and reads what enrolling it needs", () =>
    Effect.gen(function* () {
      const { checkouts, root } = yield* checkout;
      const read = yield* checkouts.inspect(yield* checkouts.rootOf(`${root}/src`));

      expect([read.root, read.repo, read.baseBranch, read.flows]).toEqual([
        root,
        "dataquail/demo",
        "main",
        ["implement", "review"],
      ]);
      expect([read.team.agent, read.team.flows]).toEqual([
        Option.some("claude"),
        { review: { agent: "codex", runners: ["bob"] } },
      ]);
      expect(yield* checkouts.exists(root)).toBe(true);
      expect(yield* checkouts.exists(`${root}/gone`)).toBe(false);
    }),
  );

  effect("refuses a path outside any checkout", () =>
    Effect.gen(function* () {
      const { checkouts } = yield* checkout;
      const fs = yield* FileSystem.FileSystem;
      const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-none-" });

      expect((yield* Effect.flip(checkouts.rootOf(elsewhere)))._tag).toBe("CheckoutUnreadable");
    }),
  );
});
