import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { effectAtHomeWith } from "../../../../../test/effect-test.ts";
import { Exec } from "../../../../platform/exec.ts";
import { TextDiffClient } from "../../domain/ports/clients/text-diff.client.ts";
import { TextDiffClientLive } from "./text-diff.client-live.ts";

// git runs for real.
const effect = effectAtHomeWith(Exec.layer.pipe(Layer.provide(BunServices.layer)));

describe("TextDiffClientLive", () => {
  effect("diffs the recipe's side against the repo's, and is empty when they match", () =>
    Effect.gen(function* () {
      const differ = yield* TextDiffClient;
      const diff = yield* differ.diff("flows/review.ts", "a\nb\n", "a\nc\n");

      expect(diff).toContain("--- recipe/.chernabog/flows/review.ts");
      expect(diff).toContain("+++ repo/.chernabog/flows/review.ts");
      expect(diff).toContain("-b\n+c");
      expect(yield* differ.diff("flows/review.ts", "same\n", "same\n")).toBe("");
    }).pipe(Effect.provide(TextDiffClientLive)),
  );

  effect(
    "merges the recipe's changes into the repo's edits, and marks where both changed a line",
    () =>
      Effect.gen(function* () {
        const differ = yield* TextDiffClient;

        const clean = yield* differ.merge(
          "flows/review.ts",
          "a\nb\nc\n",
          "a\nB\nc\n",
          "a\nb\nc\nd\n",
        );

        expect(clean).toEqual({ text: "a\nB\nc\nd\n", conflicts: false });

        const clash = yield* differ.merge("flows/review.ts", "a\nb\n", "a\nours\n", "a\ntheirs\n");
        expect(clash.conflicts).toBe(true);
        expect(clash.text).toContain("<<<<<<< repo/.chernabog/flows/review.ts\nours\n");
        expect(clash.text).toContain("||||||| copied\nb\n");
        expect(clash.text).toContain(">>>>>>> recipe/.chernabog/flows/review.ts");
      }).pipe(Effect.provide(TextDiffClientLive)),
  );
});
