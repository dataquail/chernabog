// Core's Progress port (ADR 0019): the phase format every backend accepts,
// the fake that tests use, held to the contract every adapter must meet, and
// its advance, a write the engine fences and reports by its declaration alone.

import { CAPABILITIES, Phase, PhaseWriter, Progress, ProgressCapability } from "@chernabog/core";
import { describe, expect, test } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { fencing } from "../src/modules/runs/infrastructure/runtime/engine.ts";
import { effect } from "./effect-test.ts";
import { progressContract } from "./progress-contract.ts";
import { progressFake } from "./progress-fake.ts";

progressContract("the fake", progressFake);

const decodes = (schema: typeof Phase | typeof PhaseWriter, input: string) =>
  Option.isSome(Schema.decodeOption(schema)(input));

const REVIEW_ASKED = Schema.decodeSync(Phase)("review-asked");
const RUN = Schema.decodeSync(PhaseWriter)("run-1");

describe("Phase", () => {
  test("is a short lowercase identifier, words joined by single hyphens", () => {
    expect(
      ["review-asked", "changes-asked", "approved", "v2", "phase-3a", "a".repeat(64)].map((phase) =>
        decodes(Phase, phase),
      ),
    ).toEqual([true, true, true, true, true, true]);
  });

  test("refuses what would mean something else to a commit trailer, a ref or a URL", () => {
    expect(
      [
        "",
        "review asked",
        "review-asked\nSigned-off-by: someone",
        "Review-Asked",
        "review_asked",
        "review.asked",
        "review/asked",
        "-review",
        "review-",
        "review--asked",
        "a".repeat(65),
      ].map((phase) => decodes(Phase, phase)),
    ).toEqual(Array.from({ length: 11 }, () => false));
  });
});

describe("PhaseWriter", () => {
  test("takes a run id, a login or an observer's name, on one line", () => {
    expect(
      [
        "0eee9982-bb65-4a62-b603-25023ad948cb",
        "data-quail",
        "observer:review.changesRequested",
      ].map((writer) => decodes(PhaseWriter, writer)),
    ).toEqual([true, true, true]);
    expect(
      ["", "run\nTrailer: x", "two words", ":leading", "a".repeat(129)].map((writer) =>
        decodes(PhaseWriter, writer),
      ),
    ).toEqual([false, false, false, false, false]);
  });
});

describe("ProgressCapability", () => {
  test("is one of the capabilities the engine fences and reports", () => {
    expect(CAPABILITIES).toContain(ProgressCapability);
  });

  effect("fences advance, and never a read", () =>
    Effect.gen(function* () {
      const fenced: Array<string> = [];

      const context = fencing(Context.make(Progress, yield* progressFake), (what) =>
        Effect.sync(() => {
          fenced.push(what);
        }),
      );

      yield* Effect.gen(function* () {
        const progress = yield* Progress;
        yield* progress.read("pr-73");
        yield* progress.readAll;
        yield* Effect.ignore(
          progress.advance("pr-73", {
            from: Option.none(),
            to: REVIEW_ASKED,
            by: RUN,
          }),
        );
      }).pipe(Effect.provideContext(context));

      expect(fenced).toEqual(["recording pr-73 as review-asked"]);
    }),
  );
});
