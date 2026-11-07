// What doctor says of a repo's flow documents, from what `recipes compile
// --check` makes of them (#376): a flow file that isn't what its document
// compiles to is a warning naming the flow and the fix, a document with
// problems is reported as such, and one up to date, or no document at all,
// says nothing.

import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { flowDocumentWarnings, formatCheck } from "../src/interface/cli/doctor.main.ts";

const problem = {
  file: ".chernabog/documents/review.yaml",
  line: 7,
  column: 9,
  path: "steps[1].use",
  message: "no block named pr.lands",
};

const said = (flows: Parameters<typeof flowDocumentWarnings>[1]) =>
  flowDocumentWarnings("demo", flows).map(({ fix, label }) =>
    formatCheck({ ok: true, warning: true, label, fix: Option.some(fix) }),
  );

describe("doctor's flow document warnings", () => {
  test("say nothing of a repo with no documents", () => {
    expect(said([])).toEqual([]);
  });

  test("say nothing of a flow file up to date with its document", () => {
    expect(said([{ flow: "review", outcome: "unchanged", problems: [] }])).toEqual([]);
  });

  test("warn of a flow file that isn't what its document compiles to, naming the flow and the fix", () => {
    expect(
      said([
        { flow: "review", outcome: "unchanged", problems: [] },
        { flow: "implement", outcome: "stale", problems: [] },
      ]),
    ).toEqual([
      [
        "! demo: .chernabog/flows/implement.ts isn't what its flow document compiles to; the daemon runs the flow file",
        "    fix: chernabog recipes compile implement, or, if the flow file was edited by hand, move the edit into .chernabog/documents/ and compile it",
      ].join("\n"),
    ]);
  });

  test("report a document with problems as such, not as stale", () => {
    expect(said([{ flow: "review", outcome: "problems", problems: [problem, problem] }])).toEqual([
      [
        "! demo: the review flow document has problems, so its flow file can't be checked against it (.chernabog/documents/review.yaml:7:9: steps[1].use: no block named pr.lands, and 1 more)",
        "    fix: chernabog recipes compile review says where each one is; fix them in the document",
      ].join("\n"),
    ]);
  });
});
