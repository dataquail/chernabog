import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { DocumentProblem, PhaseGap } from "../domain/ports/clients/flow-compiler.client.ts";
import { RecipeFilesFailed } from "../domain/recipe/recipe.errors.ts";
import { FlowCompilerClientFake } from "../infrastructure/clients/flow-compiler.client-fake.ts";
import { compileFlowDocumentsHandler } from "./compile-flow-documents.handler.ts";

const compiling = (source: string) => ({
  source: Option.some(source),
  problems: [],
  typeChecked: true,
});

const problem = new DocumentProblem({
  file: ".chernabog/documents/bad.yaml",
  line: 3,
  column: 5,
  path: "steps[0].use",
  message: "no block named nope",
});

const documents = {
  good: compiling("flow good"),
  same: compiling("flow same"),
  bad: { source: Option.none<string>(), problems: [problem], typeChecked: false },
};

const outcomes = (names: ReadonlyArray<string>, check: boolean, files: Map<string, string>) =>
  compileFlowDocumentsHandler({ root: "/repo", names, check }).pipe(
    Effect.map((compiled) => ({
      flows: compiled.flows.map((flow) => [flow.flow, flow.outcome] as const),
      unknown: compiled.unknown,
    })),
    Effect.provide([FlowCompilerClientFake(documents, files), PassThroughUnitOfWork]),
  );

describe("compileFlowDocumentsHandler", () => {
  effect("writes what changed, and leaves a document with problems' flow file alone", () =>
    Effect.gen(function* () {
      const files = new Map([
        ["same", "flow same"],
        ["bad", "as it was"],
      ]);

      expect(yield* outcomes([], false, files)).toEqual({
        flows: [
          ["bad", "problems"],
          ["good", "wrote"],
          ["same", "unchanged"],
        ],
        unknown: [],
      });

      expect(Object.fromEntries(files)).toEqual({
        same: "flow same",
        bad: "as it was",
        good: "flow good",
      });
    }),
  );

  effect("writes nothing when checking, and says which flow files are stale", () =>
    Effect.gen(function* () {
      const files = new Map([
        ["good", "edited by hand"],
        ["same", "flow same"],
      ]);

      expect(yield* outcomes(["good", "same"], true, files)).toEqual({
        flows: [
          ["good", "stale"],
          ["same", "unchanged"],
        ],
        unknown: [],
      });

      expect(files.get("good")).toBe("edited by hand");
    }),
  );

  effect("compiles only those named, and says which it doesn't have", () =>
    Effect.gen(function* () {
      expect(yield* outcomes(["good", "gone"], false, new Map())).toEqual({
        flows: [["good", "wrote"]],
        unknown: ["gone"],
      });
    }),
  );

  const gap = new PhaseGap({
    gap: "unrecorded",
    item: "pull-request",
    phase: "watched",
    certain: true,
    message:
      "pr.mergedRecently in post-merge reads the pull-request phase watched, but no flow records it",
  });

  const gapsOf = (gaps: Option.Option<ReadonlyArray<PhaseGap>>) =>
    compileFlowDocumentsHandler({ root: "/repo", names: ["good"], check: true }).pipe(
      Effect.map((compiled) => compiled.phaseGaps),
      Effect.provide([
        FlowCompilerClientFake(documents, new Map(), Effect.succeed(gaps)),
        PassThroughUnitOfWork,
      ]),
    );

  const failing = Effect.fail(
    new RecipeFilesFailed({ message: "can't load @chernabog/sdk from /repo/.chernabog" }),
  );

  effect("says the gaps in phases across every flow, whichever documents are named", () =>
    Effect.gen(function* () {
      expect(yield* gapsOf(Option.some([gap]))).toEqual([gap]);
    }),
  );

  effect("says nothing of phases when the repo's SDK is from before them", () =>
    Effect.gen(function* () {
      expect(yield* gapsOf(Option.none())).toBeUndefined();
    }),
  );

  // A compile of these documents whose check across flows fails.
  const compiledFailing = (
    compiled: Parameters<typeof FlowCompilerClientFake>[0],
    check: boolean,
    files: Map<string, string>,
  ) =>
    compileFlowDocumentsHandler({ root: "/repo", names: [], check }).pipe(
      Effect.provide([FlowCompilerClientFake(compiled, files, failing), PassThroughUnitOfWork]),
    );

  effect("still compiles when the check across flows fails, saying nothing of phases", () =>
    Effect.gen(function* () {
      const files = new Map([["same", "flow same"]]);
      const compiled = yield* compiledFailing(documents, false, files);

      expect(compiled.flows.map((flow) => [flow.flow, flow.outcome])).toEqual([
        ["bad", "problems"],
        ["good", "wrote"],
        ["same", "unchanged"],
      ]);
      expect(compiled.phaseGaps).toBeUndefined();
      expect(files.get("good")).toBe("flow good");
    }),
  );

  effect("reports no documents, and succeeds, when the check across flows fails", () =>
    Effect.gen(function* () {
      const compiled = yield* compiledFailing({}, true, new Map());

      expect(compiled.flows).toEqual([]);
      expect(compiled.unknown).toEqual([]);
      expect(compiled.phaseGaps).toBeUndefined();
    }),
  );
});
