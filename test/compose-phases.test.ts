// What the catalogue declares of phases, the phases each source reads and each
// block records, and the check across a repo's flows that goes by them: a
// phase read that no flow records, or recorded where nothing reads it though a
// source the SDK has would (docs/run-progress/handoffs.md, question 8).

import { Compose, Phases } from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";

import {
  ADDRESS_REVIEW_DOCUMENT,
  documentOf,
  EPIC_DOCUMENT,
  HUMAN_INITIATED_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  PLAN_DOCUMENT,
  POST_MERGE_DOCUMENT,
  RE_REVIEW_DOCUMENT,
  RESOLVE_CONFLICTS_DOCUMENT,
  REVIEW_DOCUMENT,
} from "./compose-harness.ts";

const implement = documentOf(IMPLEMENT_DOCUMENT);
const review = documentOf(REVIEW_DOCUMENT);
const reReview = documentOf(RE_REVIEW_DOCUMENT);
const addressReview = documentOf(ADDRESS_REVIEW_DOCUMENT);
const resolveConflicts = documentOf(RESOLVE_CONFLICTS_DOCUMENT);
const postMerge = documentOf(POST_MERGE_DOCUMENT);
const humanInitiated = documentOf(HUMAN_INITIATED_DOCUMENT);
const plan = documentOf(PLAN_DOCUMENT);
const epic = documentOf(EPIC_DOCUMENT);

// Every recipe, as a repo with all of them enabled has them.
const everyRecipe = [
  implement,
  review,
  reReview,
  addressReview,
  resolveConflicts,
  postMerge,
  humanInitiated,
  plan,
  epic,
];

// The post-merge document with its recording step, merged.markWatched, as given.
const MARK_WATCHED = `  - id: watching
    use: merged.markWatched
    in: { pr: trigger.pr, sha: trigger.sha, base: trigger.base }
`;

const postMergeWith = (replacement: string) => {
  expect(POST_MERGE_DOCUMENT).toContain(MARK_WATCHED);

  return documentOf(POST_MERGE_DOCUMENT.replace(MARK_WATCHED, replacement));
};

const others = everyRecipe.filter((each) => each !== postMerge);

const catalogue = Schema.decodeUnknownSync(
  Schema.Struct({
    blocks: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        records: Schema.optionalKey(Schema.Json),
        recordsInput: Schema.optionalKey(Schema.Json),
        wakeReads: Schema.optionalKey(Schema.Json),
      }),
    ),
    sources: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        reads: Schema.optionalKey(Schema.Json),
        reconciles: Schema.optionalKey(Schema.Json),
      }),
    ),
  }),
)(Compose.describe());

const blockNamed = (name: string) => catalogue.blocks.find((block) => block.name === name);

const sourceNamed = (name: string) => catalogue.sources.find((source) => source.name === name);

describe("the catalogue's phases", () => {
  test("names the SDK's phases by kind of item", () => {
    expect(Phases.PHASES.pullRequest.changesAsked).toBe("changes-asked");
    expect(Phases.phasesOf("epic")).toEqual(["waiting", "finished"]);
  });

  test("lists what each block records, and on which outcome", () => {
    expect(blockNamed("review.round")?.records).toEqual([
      { item: "pull-request", phase: "changes-asked", on: "changes" },
      { item: "pull-request", phase: "approved", on: "approve" },
    ]);

    expect(blockNamed("pr.land")?.records).toEqual([{ item: "pull-request", phase: "merge-held" }]);

    expect(blockNamed("issue.handOff")?.records).toEqual([
      { item: "pull-request", phase: "review-asked" },
      { item: "pull-request", phase: "draft" },
      { item: "issue", phase: "handed-off" },
    ]);

    expect(blockNamed("merged.markWatched")?.records).toEqual([
      { item: "pull-request", phase: "watched" },
    ]);

    expect(blockNamed("worktree.prepare")?.records).toEqual([]);
  });

  test("lists what each source reads and reconciles", () => {
    expect(sourceNamed("review.requested")?.reads).toEqual([
      { item: "pull-request", phases: ["review-asked", "draft", "ready-for-person", "none"] },
    ]);

    expect(sourceNamed("review.changesRequested")).toMatchObject({
      reads: [{ item: "pull-request", phases: ["changes-asked", "none"] }],
      reconciles: [
        {
          item: "pull-request",
          from: ["review-asked", "review-asked-again", "approved", "draft", "ready-for-person"],
          to: "changes-asked",
        },
      ],
    });

    expect(sourceNamed("review.requestedAgain")).toMatchObject({
      reads: [{ item: "pull-request", phases: ["review-asked-again", "none"] }],
      reconciles: [
        {
          item: "pull-request",
          from: ["review-asked", "changes-asked", "approved", "draft", "ready-for-person"],
          to: "review-asked-again",
        },
      ],
    });

    expect(sourceNamed("pr.mergedRecently")?.reads).toEqual([
      { item: "pull-request", phases: ["watched"] },
    ]);

    expect(sourceNamed("issues.queued")?.reads).toEqual([]);
  });

  test("lists the phases a block's wakes read beside what it records", () => {
    expect(blockNamed("pr.awaitReady")).toMatchObject({
      records: [{ item: "issue", phase: "awaiting-ready" }],
      wakeReads: [{ item: "issue", phases: ["awaiting-ready"] }],
    });
  });

  test("says progress.advance records the phase its document names", () => {
    expect(blockNamed("progress.advance")).toMatchObject({
      records: [],
      recordsInput: "phase",
    });
  });
});

describe("Compose.progressOf", () => {
  test("gathers what a document's sources and blocks read and record, deep in branches too", () => {
    const progress = Compose.progressOf(postMerge);

    expect(progress.reads).toEqual([
      { flow: "post-merge", item: "pull-request", phase: "watched", by: "pr.mergedRecently" },
    ]);

    expect(progress.records).toEqual([
      { flow: "post-merge", item: "pull-request", phase: "watched", by: "merged.markWatched" },
    ]);

    expect(Compose.progressOf(review).records).toContainEqual({
      flow: "review",
      item: "pull-request",
      phase: "merge-held",
      by: "pr.land",
    });
  });

  test("takes a team's own progress.advance on the item its subject is", () => {
    const advanced = postMergeWith(`  - id: watching
    use: progress.advance
    with: { phase: watched }
`);

    expect(Compose.progressOf(advanced).records).toEqual([
      { flow: "post-merge", item: "pull-request", phase: "watched", by: "progress.advance" },
    ]);
  });
});

describe("Compose.phaseGaps", () => {
  test("finds no phase read that nothing records across every recipe", () => {
    expect(Compose.phaseGaps(everyRecipe)).toEqual([]);
  });

  test("warns when a scenario document's recording step is removed", () => {
    const sabotaged = postMergeWith("");

    expect(Compose.check(sabotaged)).toEqual([]);

    expect(Compose.phaseGaps([...others, sabotaged])).toEqual([
      {
        gap: "unrecorded",
        item: "pull-request",
        phase: "watched",
        certain: true,
        message:
          "pr.mergedRecently in post-merge reads the pull-request phase watched, but no flow records it: merged.markWatched records it",
      },
    ]);
  });

  test("takes a team's own step that records the phase in place of the block", () => {
    const advanced = postMergeWith(`  - id: watching
    use: progress.advance
    with: { phase: watched }
`);

    expect(Compose.check(advanced)).toEqual([]);
    expect(Compose.phaseGaps([...others, advanced])).toEqual([]);
  });

  test("warns when a phase is recorded but no flow has the source that reads it", () => {
    expect(Compose.phaseGaps([implement])).toEqual([
      {
        gap: "unread",
        item: "pull-request",
        phase: "draft",
        certain: true,
        message:
          "issue.handOff in implement records the pull-request phase draft, but no flow reads it: review.requested reads it",
      },
      {
        gap: "unread",
        item: "pull-request",
        phase: "review-asked",
        certain: true,
        message:
          "issue.handOff and issue.handOffAdopted in implement record the pull-request phase review-asked, but no flow reads it: review.requested and review.waitingElsewhere read it",
      },
    ]);
  });

  test("needs nothing recorded for a source that also finds items with no record", () => {
    // review.requested takes a pull request a person opened, which has none.
    expect(Compose.phaseGaps([review])).toEqual([
      {
        gap: "unread",
        item: "pull-request",
        phase: "changes-asked",
        certain: true,
        message:
          "review.round in review records the pull-request phase changes-asked, but no flow reads it: review.changesRequested reads it",
      },
    ]);
  });

  test("allows a phase recorded for status, which no source reads", () => {
    const gaps = Compose.phaseGaps(everyRecipe);

    expect(gaps.some((gap) => gap.phase === "handed-off" || gap.phase === "draft")).toBe(false);

    const teams = postMergeWith(`${MARK_WATCHED}  - id: triaged
    use: progress.advance
    with: { phase: triaged }
`);

    expect(Compose.phaseGaps([...others, teams])).toEqual([]);
  });

  test("can't tell, rather than warns, when a flow without a document declares nothing", () => {
    const sabotaged = postMergeWith("");

    expect(Compose.phaseGaps([...others, sabotaged], ["watch-merges"])).toEqual([
      {
        gap: "unrecorded",
        item: "pull-request",
        phase: "watched",
        certain: false,
        message:
          "pr.mergedRecently in post-merge reads the pull-request phase watched, but no flow records it: merged.markWatched records it; watch-merges has no document and declares nothing, so it may",
      },
    ]);
  });

  test("suggests the nearest phase recorded to one read that nothing records", () => {
    const misnamed = postMergeWith(`  - id: watching
    use: progress.advance
    with: { phase: watchd }
`);

    // A phase the SDK has is refused in the document itself; this one passes
    // the check across flows only because no source reads it.
    expect(Compose.phaseGaps([...others, misnamed]).map((gap) => gap.message)).toEqual([
      "pr.mergedRecently in post-merge reads the pull-request phase watched, but no flow records it: merged.markWatched records it; did you mean watchd, which post-merge records?",
    ]);
  });
});

describe("Compose.check of progress.advance", () => {
  const advancing = (phase: string) =>
    postMergeWith(`  - id: watching
    use: progress.advance
    with: { phase: ${phase} }
`);

  test("takes a team's own phase, and the SDK's", () => {
    expect(Compose.check(advancing("triaged"))).toEqual([]);
    expect(Compose.check(advancing("watched"))).toEqual([]);
  });

  test("suggests the SDK's phase nearest to a misspelled one", () => {
    expect(Compose.check(advancing("wached"))).toEqual([
      {
        path: "steps[0].with.phase",
        message:
          "wached is a pull-request phase so close to one of the SDK's that it reads as a slip: did you mean watched? A team's own phase needs a name of its own",
      },
    ]);
  });

  test("refuses what isn't a phase's name", () => {
    expect(Compose.check(advancing('"Ready To Go"'))).toEqual([
      {
        path: "steps[0].with.phase",
        message: "must be a phase's name: lower-case words joined by hyphens, such as triaged",
      },
    ]);
  });

  test("wants the phase under with", () => {
    const wired = documentOf(
      POST_MERGE_DOCUMENT.replace(
        MARK_WATCHED,
        `  - id: watching
    use: progress.advance
    in: { phase: trigger.sha }
`,
      ),
    );

    expect(Compose.check(wired).map((problem) => problem.path)).toContain("steps[0].in.phase");
  });
});
