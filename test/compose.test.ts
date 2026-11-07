// What a flow document's checks catch: `Compose.check` for what can be said of
// the document itself, `tsc` on its flow file for what its types say, and what
// a block's failure table turns each error into.

import {
  Blocks,
  Compose,
  type Epic,
  type EpicBlocks,
  type FlowError,
  Implement,
  NeedsHuman,
  NotFound,
  NothingCommitted,
  PullRequestClosed,
  Skip,
  StepFailed,
} from "@chernabog/sdk";
import { describe, expect, test } from "bun:test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  ADDRESS_REVIEW_DOCUMENT,
  compileErrors,
  documentOf,
  EPIC_DOCUMENT,
  generated,
  HUMAN_INITIATED_DOCUMENT,
  IMPLEMENT_DOCUMENT,
  PLAN_DOCUMENT,
  POST_MERGE_DOCUMENT,
  RE_REVIEW_DOCUMENT,
  RESOLVE_CONFLICTS_DOCUMENT,
  REVIEW_DOCUMENT,
  REVIEW_WITH_STAGE_DOCUMENT,
  STAGE_FILES,
} from "./compose-harness.ts";
import { effect } from "./effect-test.ts";

type Doc = Compose.FlowDocument;

type Step = Compose.Step;

type UseStep = Compose.UseStep;

const implement = documentOf(IMPLEMENT_DOCUMENT);
const review = documentOf(REVIEW_DOCUMENT);
const reReview = documentOf(RE_REVIEW_DOCUMENT);
const addressReview = documentOf(ADDRESS_REVIEW_DOCUMENT);
const resolveConflicts = documentOf(RESOLVE_CONFLICTS_DOCUMENT);
const postMerge = documentOf(POST_MERGE_DOCUMENT);
const humanInitiated = documentOf(HUMAN_INITIATED_DOCUMENT);

// The address-review document with a line of it changed.
const addressReviewWith = (line: string, replacement: string) => {
  expect(ADDRESS_REVIEW_DOCUMENT).toContain(line);

  return documentOf(ADDRESS_REVIEW_DOCUMENT.replace(line, replacement));
};

// The resolve-conflicts document with a line of it changed.
const resolveConflictsWith = (line: string, replacement: string) => {
  expect(RESOLVE_CONFLICTS_DOCUMENT).toContain(line);

  return documentOf(RESOLVE_CONFLICTS_DOCUMENT.replace(line, replacement));
};

// The post-merge document with a line of it changed.
const postMergeWith = (line: string, replacement: string) => {
  expect(POST_MERGE_DOCUMENT).toContain(line);

  return documentOf(POST_MERGE_DOCUMENT.replace(line, replacement));
};

// The human-initiated document with a line of it changed.
const humanInitiatedWith = (line: string, replacement: string) => {
  expect(HUMAN_INITIATED_DOCUMENT).toContain(line);

  return documentOf(HUMAN_INITIATED_DOCUMENT.replace(line, replacement));
};

// The re-review document with a line of it changed, for a change deep in its branches.
const reReviewWith = (line: string, replacement: string) => {
  expect(RE_REVIEW_DOCUMENT).toContain(line);

  return documentOf(RE_REVIEW_DOCUMENT.replace(line, replacement));
};

const named = (step: Step, id: string) => Compose.isUse(step) && step.id === id;

const withSteps = (doc: Doc, steps: ReadonlyArray<Step>): Doc => ({ ...doc, steps });

// The document with the step changed.
const changing = (doc: Doc, id: string, change: (step: UseStep) => UseStep): Doc =>
  withSteps(
    doc,
    doc.steps.map((step) => {
      if (Compose.isUse(step) && step.id === id) {
        return change(step);
      }

      return step;
    }),
  );

const wiring = (doc: Doc, id: string, input: string, reference: string) =>
  changing(doc, id, (step) => ({ ...step, in: { ...step.in, [input]: reference } }));

const without = (doc: Doc, id: string) =>
  withSteps(
    doc,
    doc.steps.filter((step) => !named(step, id)),
  );

const stepOf = (doc: Doc, id: string) => doc.steps.filter((step) => named(step, id));

// The document with the step moved to just before another.
const moved = (doc: Doc, id: string, before: string) => {
  const rest = without(doc, id).steps;
  const at = rest.findIndex((step) => named(step, before));

  return withSteps(doc, [...rest.slice(0, at), ...stepOf(doc, id), ...rest.slice(at)]);
};

const messages = (doc: Doc) => Compose.check(doc).map((problem) => problem.message);

const paths = (doc: Doc) => Compose.check(doc).map((problem) => problem.path);

describe("Compose.read", () => {
  const problemsOf = (value: Schema.Json) =>
    Result.match(Compose.read(value), {
      onSuccess: () => [],
      onFailure: (problems) => problems,
    });

  const withStep = (step: Schema.Json) => ({
    flow: "x",
    subject: "pull-request",
    trigger: [],
    steps: [step],
  });

  test("says where a document's form is wrong, in a line", () => {
    expect(problemsOf(withStep({ id: "a", use: 5 }))).toEqual([
      { path: "steps[0].use", message: "Expected string" },
    ]);

    expect(
      problemsOf(
        withStep({
          id: "a",
          use: "b",
          on: { approve: { as: 5, steps: [{ id: "c", use: "d" }] } },
        }),
      ),
    ).toEqual([
      {
        path: "steps[0].on.approve.as",
        message: "Expected string",
      },
    ]);

    expect(problemsOf(withStep({ end: "nope" }))[0]?.path).toBe("steps[0]");
    expect(problemsOf({ flow: "x" }).map((each) => each.path)).toEqual([
      "subject",
      "trigger",
      "steps",
    ]);
    expect(problemsOf({ ...withStep({ end: "done" }), concurrency: 1.5 })[0]?.path).toBe(
      "concurrency",
    );
    expect(problemsOf(["a"])[0]?.path).toBe("");
  });

  test("says a step is no form of step, rather than lacking the first form's key", () => {
    expect(problemsOf(withStep({ id: "a" }))).toEqual([
      {
        path: "steps[0]",
        message:
          "must be a step: use (a block, with an id), stage (a step of the repo's own, with an id), end, next, first, repeat or forEach",
      },
    ]);
  });

  test("takes the implement and review documents", () => {
    expect(implement.flow).toBe("implement");
    expect(review.subject).toBe("pull-request");
  });

  test("refuses what isn't a document, without throwing", () => {
    const nonsenses: ReadonlyArray<Schema.Json> = [
      1,
      "flow",
      [],
      {},
      { subject: "issue", steps: 3 },
    ];

    for (const nonsense of nonsenses) {
      expect(Result.isFailure(Compose.read(nonsense))).toBe(true);
    }
  });

  const problemsIn = (steps: Schema.Json) =>
    Result.match(Compose.read({ flow: "x", subject: "issue", trigger: [], steps }), {
      onSuccess: () => [],
      onFailure: (problems) => problems.map((each) => [each.path, each.message]),
    });

  test("says which step has no id, deep in a branch too", () => {
    expect(problemsIn([{ use: "issue.claim" }])).toEqual([
      ["steps[0]", "a use step needs an id, which later steps name it by"],
    ]);

    expect(
      problemsIn([{ id: "a", use: "b", on: { yes: { steps: [{ use: "issue.claim" }] } } }]),
    ).toEqual([
      ["steps[0].on.yes.steps[0]", "a use step needs an id, which later steps name it by"],
    ]);
  });

  test("says what a step that is none of them could be", () => {
    expect(problemsIn([{ id: "a" }])[0]?.[1]).toContain(
      "must be a step: use (a block, with an id)",
    );
  });

  test("takes a flow a person starts in place of a trigger", () => {
    const started = Result.getOrThrow(
      Compose.read({ flow: "x", subject: "issue", start: true, steps: [{ end: "done" }] }),
    );

    expect(started).toMatchObject({ start: true, trigger: [] });

    expect(
      problemsOf({ flow: "x", subject: "issue", start: false, steps: [{ end: "done" }] }),
    ).toEqual([{ path: "start", message: "Expected true" }]);
  });

  test("says a document with neither a trigger nor start is missing its trigger", () => {
    expect(problemsOf({ flow: "x", subject: "issue", steps: [{ end: "done" }] })).toEqual([
      {
        path: "trigger",
        message:
          "is missing: name where the flow's work comes from, or say start: true for a flow a person starts with chernabog start <issue>. chernabog recipes blocks shows the format.",
      },
    ]);
  });

  test("says what a document leaves out, and where to find the format", () => {
    const said = Result.match(Compose.read({ flow: "x" }), {
      onSuccess: () => [],
      onFailure: (problems) => problems.map((each) => [each.path, each.message]),
    });

    expect(said).toContainEqual([
      "subject",
      "is missing. chernabog recipes blocks shows the format.",
    ]);
  });
});

describe("Compose.check", () => {
  test("finds nothing wrong with the implement and review documents", () => {
    expect(Compose.check(implement)).toEqual([]);
    expect(Compose.check(review)).toEqual([]);
  });

  test("names a removed step everywhere that used it, by where in the document", () => {
    expect(paths(without(implement, "worktree"))).toEqual([
      "steps[1].in.worktree",
      "steps[2].in.worktree",
      "steps[3].in.worktree",
      "steps[5].in.worktree",
    ]);
  });

  test("says what is available where a reference doesn't resolve", () => {
    expect(messages(moved(implement, "opened", "push"))[0]).toContain("push is not available here");
  });

  test("keeps what a branch binds to the branch", () => {
    expect(messages(wiring(implement, "done", "pr", "adopted"))[0]).toContain(
      "adopted is not available here",
    );
  });

  test("wants the outcomes a block must route routed", () => {
    expect(messages(changing(implement, "agent", ({ on: _on, ...unrouted }) => unrouted))).toEqual([
      "agent.implement can come to needs-clarification, and this doesn't say what then",
    ]);
  });

  test("refuses an outcome a block doesn't have", () => {
    const flaky = changing(implement, "gate", (step) => ({
      ...step,
      on: { flaky: { steps: [{ end: "done" }] } },
    }));

    expect(messages(flaky)).toEqual(["gate.local comes to nothing to route"]);
  });

  test("wants a block's required inputs, and only those it takes", () => {
    expect(messages(changing(implement, "gate", (step) => ({ ...step, in: {} })))).toEqual([
      "gate.local needs worktree",
    ]);

    expect(messages(wiring(implement, "gate", "colour", "claim.branch"))).toEqual([
      "gate.local takes worktree, lane",
    ]);
  });

  test("refuses a block twice on one path, whose step names would collide", () => {
    const pushing = stepOf(implement, "push").map((step) => ({ ...step, id: "pushAgain" }));
    const at = implement.steps.findIndex((step) => named(step, "opened"));

    const again = withSteps(implement, [
      ...implement.steps.slice(0, at),
      ...pushing,
      ...implement.steps.slice(at),
    ]);

    expect(messages(again).join("\n")).toContain("branch.push runs twice on one path");
  });

  describe("refuses two blocks on one path that use the same step names", () => {
    const before = (doc: Doc, id: string, step: UseStep) => {
      const at = doc.steps.findIndex((each) => named(each, id));

      return withSteps(doc, [...doc.steps.slice(0, at), step, ...doc.steps.slice(at)]);
    };

    const ciAgain = {
      id: "ciAgain",
      use: "ci.waitPreparing",
      in: { pr: "opened.number", branch: "claim.branch", base: "claim.base" },
    };

    test("waiting on CI both ways", () => {
      expect(messages(before(implement, "done", ciAgain))).toEqual([
        "ci.waitPreparing runs on one path with ci.waitAndFix, and their step names would collide",
      ]);
    });

    test("preparing a worktree and a block that prepares its own", () => {
      expect(messages(before(implement, "gate", ciAgain))).toContain(
        "ci.waitPreparing runs on one path with worktree.prepare, and their step names would collide",
      );
    });

    test("handing off both ways", () => {
      const handOffAgain = {
        id: "handOffAgain",
        use: "issue.handOffAdopted",
        in: { issue: "trigger.issue", adopted: "opened", branch: "claim.branch" },
      };

      const after = withSteps(implement, [
        ...implement.steps.slice(0, -1),
        handOffAgain,
        ...implement.steps.slice(-1),
      ]);

      expect(messages(after)).toEqual([
        "issue.handOffAdopted runs on one path with issue.handOff, and their step names would collide",
      ]);
    });
  });

  test("catches a branch that falls through into the rest of the flow", () => {
    // Without its end, the adopted path runs on into the main path, and a
    // block on both collides.
    const fallsThrough = changing(implement, "claim", (step) => ({
      ...step,
      on: {
        adopted: {
          as: "adopted",
          steps: [
            {
              id: "handedOver",
              use: "issue.handOff",
              in: { issue: "trigger.issue", pr: "adopted", outcome: "adopted" },
            },
          ],
        },
      },
    }));

    expect(messages(fallsThrough).join("\n")).toContain("issue.handOff runs twice on one path");
  });

  test("allows a block on two paths when the first ends", () => {
    const ends = changing(implement, "claim", (step) => ({
      ...step,
      on: {
        adopted: {
          as: "adopted",
          steps: [
            {
              id: "handedOver",
              use: "issue.handOff",
              in: { issue: "trigger.issue", pr: "adopted", outcome: "adopted" },
            },
            { end: "done" },
          ],
        },
      },
    }));

    expect(Compose.check(ends)).toEqual([]);
  });

  test("knows nothing follows a block whose every outcome ends", () => {
    expect(messages(withSteps(review, [...review.steps, { end: "done" }]))).toEqual([
      "no run can reach this step",
    ]);
  });

  test("refuses steps no run can reach", () => {
    const stops = withSteps(implement, [{ end: "done" }, ...implement.steps]);
    expect(messages(stops)).toEqual(["no run can reach this step"]);
  });

  test("refuses a name the generated flow uses itself", () => {
    expect(paths(changing(implement, "gate", (step) => ({ ...step, id: "trigger" })))).toContain(
      "steps[3].id",
    );
  });

  describe("takes only names where the generated flow writes a name", () => {
    const INJECTED = "x = console.log('PWN'), y";

    const binding = (doc: Doc, as: string) =>
      changing(doc, "claim", (step) => ({
        ...step,
        on: {
          adopted: { as, steps: [{ end: "needs-human", reason: "trigger.issue" }] },
        },
      }));

    test("in what a branch binds", () => {
      for (const name of [INJECTED, "a.b", "", "x\ny"]) {
        expect(paths(binding(implement, name))).toContain("steps[0].on.adopted.as");
      }
    });

    test("and refuses what the generated flow relies on", () => {
      for (const name of ["trigger", "Option", "Effect", "failureContext"]) {
        expect(messages(binding(implement, name))).toContain(
          `${name} can't name what a branch binds`,
        );
      }
    });

    test("and refuses a name already in scope", () => {
      expect(messages(binding(implement, "claim"))).toContain("claim is already a step here");
    });

    test("and allows the same name on another path", () => {
      const twice = withSteps(implement, [
        ...changing(implement, "claim", (step) => ({
          ...step,
          on: { adopted: { as: "found", steps: [{ end: "done" }] } },
        })).steps.slice(0, 1),
        {
          id: "again",
          use: "review.round",
          in: { pr: "claim.adopted" },
          with: { round: 1, role: "reviewer" },
          on: {
            approve: { as: "found", steps: [{ end: "done" }] },
            changes: { steps: [{ end: "done" }] },
          },
        },
      ]);

      expect(paths(twice)).not.toContain("steps[1].on.approve.as");
    });

    test("in a reference that keeps the failure context", () => {
      const injected =
        "opened.number); console.log('PWN'); failureContext.pr = Option.some(opened.number";

      expect(messages({ ...implement, failureContext: { pr: [injected] } })).toEqual([
        "must name a step's output, as step.field",
      ]);
    });

    test("in the flow's name, which the generated flow's header says", () => {
      for (const flow of ["x\nconsole.log('PWN'); //", "x\r\ny", "x y", "*/", ""]) {
        expect(paths({ ...implement, flow })).toEqual(["flow"]);
      }
    });

    test("so generate writes none of it", () => {
      const refused = [
        binding(implement, INJECTED),
        { ...implement, failureContext: { pr: ["opened.number); evil("] } },
        { ...implement, flow: "x\nevil();" },
      ];

      for (const document of refused) {
        expect(Result.isFailure(Compose.generate(document))).toBe(true);
      }
    });
  });

  test("knows what a subject's trigger gives", () => {
    expect(messages(wiring(implement, "claim", "issue", "trigger.pr"))).toEqual([
      "the trigger of a flow on issue gives issue, queued",
    ]);
  });

  test("says which of in and with an input goes under", () => {
    expect(
      messages(
        changing(review, "review", (step) => ({
          ...step,
          in: { ...step.in, role: "reviewer" },
          with: { round: 1 },
        })),
      ),
    ).toEqual(["role is a fixed value: put it under with, not in"]);

    expect(
      messages(
        changing(implement, "gate", () => ({
          id: "gate",
          use: "gate.local",
          with: { worktree: "worktree" },
        })),
      ),
    ).toEqual(["worktree comes from an earlier step: put it under in, as step or step.field"]);

    expect(messages(wiring(implement, "gate", "worktree", "$worktree"))).toEqual([
      "must name an earlier step by its id, or a field of its output as step.field",
    ]);
  });

  test("names the blocks there are when one isn't", () => {
    const unknown = changing(implement, "gate", (step) => ({ ...step, use: "gate.lint" }));
    expect(messages(unknown)[0]).toContain("no block named gate.lint; there are");
  });

  test("knows the sources and subjects there are", () => {
    expect(messages({ ...implement, trigger: [{ use: "cron" }] })[0]).toContain("issues.queued");

    expect(messages({ ...implement, trigger: [] })).toEqual([
      "must name where the flow's work comes from",
    ]);

    expect(messages({ ...implement, subject: "release" })).toEqual([
      "must be one of changes-asked, conflict, epic, issue, merged, spec, pull-request",
    ]);
  });

  test("refuses a source that finds work on another subject", () => {
    expect(messages({ ...review, trigger: implement.trigger })).toEqual([
      "issues.queued finds work on issue, and this is a flow on pull-request",
    ]);

    expect(
      messages({
        ...implement,
        trigger: [...implement.trigger, { use: "review.requested" }],
      }),
    ).toEqual(["review.requested finds work on pull-request, and this is a flow on issue"]);

    expect(paths({ ...implement, trigger: review.trigger })).toEqual([
      "trigger[0].use",
      "trigger[1].use",
    ]);
  });

  test("checks what keeps the failure context", () => {
    expect(messages({ ...implement, failureContext: { branch: ["claim.branch"] } })[0]).toBe(
      "a flow on issue keeps pr for its failures",
    );

    expect(messages({ ...implement, failureContext: { pr: ["nothing.number"] } })).toEqual([
      "no step named nothing sets it",
    ]);

    expect(messages({ ...review, failureContext: { pr: ["review.pr"] } })).toEqual([
      "a flow on pull-request keeps nothing for its failures",
    ]);
  });

  test("refuses a re-review that doesn't say what happens past reviewRounds", () => {
    const uncapped = reReviewWith(
      `            in: { review: own }
            on:
              exhausted:
                as: why
                steps:
                  - id: capped
                    use: pr.handToPerson
                    in: { pr: trigger.pr, reason: why }
                  - end: needs-human
                    reason: capped
`,
      "            in: { review: own }\n",
    );

    expect(Compose.check(uncapped)).toEqual([
      {
        path: "steps[0].on.found.steps[0].on",
        message: "review.roundsLeft can come to exhausted, and this doesn't say what then",
      },
    ]);
  });

  test("refuses a re-review that has no first review for a pull request it never reviewed", () => {
    const resumeOnly = reReviewWith("      none:\n", "      nothing:\n");

    expect(messages(resumeOnly)).toEqual([
      "review.latestOwn can come to none, and this doesn't say what then",
      "review.latestOwn comes to found, none",
    ]);
  });

  test("refuses an address-review that doesn't say what happens when the author disputes", () => {
    const undisputed = addressReviewWith(
      `    in: { pr: trigger.pr, review: asked, session: author }
    on:
      decline:
        as: dispute
        steps:
          - id: replied
            use: author.dispute
            in: { pr: trigger.pr, review: asked, dispute: dispute }
          - id: disputed
            use: pr.handToPerson
            in: { pr: trigger.pr, reason: replied }
          - end: needs-human
            reason: disputed
`,
      "    in: { pr: trigger.pr, review: asked, session: author }\n",
    );

    expect(Compose.check(undisputed)).toEqual([
      {
        path: "steps[3].on",
        message: "author.consider can come to decline, and this doesn't say what then",
      },
    ]);
  });

  test("refuses an address-review that doesn't say what happens to the author's questions", () => {
    const unasked = addressReviewWith("      needs-clarification:\n", "      questions:\n");

    expect(messages(unasked)).toEqual([
      "author.address can come to needs-clarification, and this doesn't say what then",
      "author.address comes to needs-clarification",
    ]);
  });

  test("knows what the trigger of a flow on changes-asked gives", () => {
    const headRef = addressReviewWith(
      "in: { branch: trigger.branch }",
      "in: { branch: trigger.headRef }",
    );

    expect(Compose.check(headRef)).toEqual([
      {
        path: "steps[2].in.branch",
        message:
          "the trigger of a flow on changes-asked gives pr, branch, base, reviewer, reviewedSha",
      },
    ]);
  });

  test("refuses review.changesRequested on a flow that isn't on changes-asked", () => {
    expect(messages({ ...review, trigger: addressReview.trigger })).toEqual([
      "review.changesRequested finds work on changes-asked, and this is a flow on pull-request",
    ]);
  });

  test("refuses the push of a fix before the author made it", () => {
    expect(messages(moved(addressReview, "pushed", "addressed")).join("\n")).toContain(
      "author.address must run before author.push, and this runs after it",
    );
  });

  test("refuses asking the reviewer again before CI", () => {
    expect(messages(moved(addressReview, "again", "ci")).join("\n")).toContain(
      "author.waitForCi must run before review.askAgain, and this runs after it",
    );
  });

  test("refuses a resolve-conflicts that doesn't say what happens when a person must settle the conflict", () => {
    const unsettled = resolveConflictsWith(
      `    in: { pr: trigger.pr, branch: trigger.branch, base: trigger.base, worktree: worktree }
    on:
      needs-human:
        as: stuck
        steps:
          - id: handed
            use: pr.handToPerson
            in: { pr: trigger.pr, reason: stuck.reason }
          - end: needs-human
            reason: handed
`,
      "    in: { pr: trigger.pr, branch: trigger.branch, base: trigger.base, worktree: worktree }\n",
    );

    expect(Compose.check(unsettled)).toEqual([
      {
        path: "steps[1].on",
        message: "conflict.resolve can come to needs-human, and this doesn't say what then",
      },
    ]);
  });

  test("knows what the trigger of a flow on conflict gives", () => {
    const headRef = resolveConflictsWith(
      "in: { branch: trigger.branch }",
      "in: { branch: trigger.headRef }",
    );

    expect(Compose.check(headRef)).toEqual([
      {
        path: "steps[0].in.branch",
        message: "the trigger of a flow on conflict gives pr, branch, base",
      },
    ]);
  });

  test("refuses pr.conflicting on a flow that isn't on conflict", () => {
    expect(messages({ ...review, trigger: resolveConflicts.trigger })).toEqual([
      "pr.conflicting finds work on conflict, and this is a flow on pull-request",
    ]);
  });

  test("refuses the push of a merge before it is resolved", () => {
    expect(messages(moved(resolveConflicts, "pushed", "resolved")).join("\n")).toContain(
      "conflict.resolve must run before conflict.push, and this runs after it",
    );
  });

  test("refuses asking the approver again before CI", () => {
    expect(messages(moved(resolveConflicts, "again", "ci")).join("\n")).toContain(
      "conflict.waitForCi must run before conflict.askApproverAgain, and this runs after it",
    );
  });

  test("finds nothing wrong with the post-merge document", () => {
    expect(Compose.check(postMerge)).toEqual([]);
  });

  test("refuses a post-merge that doesn't say what happens when the merge commit's CI is red", () => {
    const [watching, ci] = postMerge.steps;

    const unrouted = Option.getOrThrow(
      Option.liftPredicate(ci, (step): step is UseStep => Compose.isUse(step)),
    );

    const on = Object.fromEntries(
      Object.entries(unrouted.on ?? {}).filter(([outcome]) => outcome !== "red"),
    );

    expect(Compose.check({ ...postMerge, steps: [watching, { ...unrouted, on }] })).toEqual([
      {
        path: "steps[1].on",
        message: "merged.awaitCi can come to red, and this doesn't say what then",
      },
    ]);
  });

  test("refuses a post-merge that doesn't say what happens when CI was already red", () => {
    const unsaid = postMergeWith(
      `            in: { pr: trigger.pr, sha: trigger.sha }
            on:
              already-red:
                as: already
                steps:
                  - end: done
                    summary: already.summary
`,
      "            in: { pr: trigger.pr, sha: trigger.sha }\n",
    );

    expect(Compose.check(unsaid)).toEqual([
      {
        path: "steps[1].on.red.steps[0].on",
        message: "merged.redBefore can come to already-red, and this doesn't say what then",
      },
    ]);
  });

  test("knows what the trigger of a flow on merged gives", () => {
    const head = postMergeWith(
      "use: merged.markWatched\n    in: { pr: trigger.pr, sha: trigger.sha",
      "use: merged.markWatched\n    in: { pr: trigger.pr, sha: trigger.head",
    );

    expect(Compose.check(head)).toEqual([
      {
        path: "steps[0].in.sha",
        message: "the trigger of a flow on merged gives pr, url, title, sha, base, issue",
      },
    ]);
  });

  test("refuses pr.mergedRecently on a flow that isn't on merged", () => {
    expect(messages({ ...review, trigger: postMerge.trigger })).toEqual([
      "pr.mergedRecently finds work on merged, and this is a flow on pull-request",
    ]);
  });

  test("finds nothing wrong with the human-initiated document", () => {
    expect(Compose.check(humanInitiated)).toEqual([]);
  });

  test("refuses a flow a person starts that also has a trigger", () => {
    expect(Compose.check({ ...humanInitiated, trigger: implement.trigger })).toEqual([
      {
        path: "start",
        message:
          "a flow a person starts has no trigger: say start: true or name a trigger, not both",
      },
    ]);
  });

  test("refuses a flow a person starts on a subject they can't name", () => {
    const started = documentOf(
      REVIEW_DOCUMENT.replace(
        "trigger:\n  - use: review.requested\n  - use: review.waitingElsewhere\n",
        "start: true\n",
      ),
    );

    expect(Compose.check(started)).toEqual([
      {
        path: "start",
        message:
          "a person starts only a flow on issue, with chernabog start <issue>, and this is a flow on pull-request",
      },
      // Merging waits out red CI on the base, which only a trigger tells it has turned green.
      {
        path: "steps[0].on.approve.steps[0].use",
        message:
          "pr.land waits for the flow's trigger to wake it, and a flow a person starts has no trigger",
      },
    ]);
  });

  test("refuses a flow a person starts that parks in a block only a trigger wakes", () => {
    const parked = humanInitiatedWith(
      "  - id: worktree\n",
      `  - id: ready
    use: pr.awaitReady
    in: { issue: trigger.issue, adopted: claim }
    with: { within: 14 days }
  - id: worktree
`,
    );

    expect(Compose.check(parked)).toEqual([
      {
        path: "steps[1].use",
        message:
          "pr.awaitReady waits for the flow's trigger to wake it, and a flow a person starts has no trigger",
      },
    ]);
  });

  test("generate refuses a document with problems, and says them", () => {
    expect(Result.isSuccess(Compose.generate(without(implement, "gate")))).toBe(true);
    expect(Result.isFailure(Compose.generate({ ...implement, trigger: [] }))).toBe(true);
  });
});

// Bad wiring `check` can't see, since it needs the outputs' types.
describe("tsc on a document's flow file", () => {
  const TIMEOUT = 120_000;

  const rejected = (name: string, doc: Doc, says: string) => {
    effect(
      name,
      () =>
        Effect.gen(function* () {
          expect(Compose.check(doc)).toEqual([]);
          expect((yield* compileErrors(doc)).join("\n")).toContain(says);
        }),
      TIMEOUT,
    );
  };

  effect(
    "compiles the implement, review, re-review, address-review, resolve-conflicts, post-merge and human-initiated documents",
    () =>
      Effect.gen(function* () {
        expect(yield* compileErrors(implement)).toEqual([]);
        expect(yield* compileErrors(review)).toEqual([]);
        expect(yield* compileErrors(reReview)).toEqual([]);
        expect(yield* compileErrors(addressReview)).toEqual([]);
        expect(yield* compileErrors(postMerge)).toEqual([]);
        expect(yield* compileErrors(resolveConflicts)).toEqual([]);
        expect(yield* compileErrors(humanInitiated)).toEqual([]);
      }),
    TIMEOUT,
  );

  rejected(
    "a push of what the person's session didn't commit",
    humanInitiatedWith("committed: session.committed", "committed: session.finished"),
    "Committed",
  );

  rejected(
    "a hybrid pull request opened without the push",
    humanInitiatedWith("pushed: push.pushed", "pushed: session.committed"),
    "Pushed",
  );

  rejected(
    "a hand-off without what open-pr recorded",
    humanInitiatedWith("finished: session.finished }", "finished: session.committed }"),
    "title, body, summary",
  );

  rejected(
    "a push of a fix the author didn't commit",
    addressReviewWith("committed: addressed.committed", "committed: asked"),
    "Committed",
  );

  rejected(
    "asking the reviewer again for a fix that wasn't pushed",
    addressReviewWith("pushed: pushed.pushed", "pushed: addressed.committed"),
    "Pushed",
  );

  rejected(
    "a fix answered in something other than the author's session",
    addressReviewWith(
      "in: { pr: trigger.pr, review: asked, session: author }\n    on:\n      needs",
      "in: { pr: trigger.pr, review: asked, session: trigger.pr }\n    on:\n      needs",
    ),
    "AuthorSession",
  );

  rejected(
    "a push of a merge that wasn't resolved",
    resolveConflictsWith("committed: resolved.committed", "committed: resolved.summary"),
    "Committed",
  );

  rejected(
    "asking the approver again about a merge that wasn't pushed",
    resolveConflictsWith(
      "in: { pr: trigger.pr, base: trigger.base, pushed: pushed.pushed }",
      "in: { pr: trigger.pr, base: trigger.base, pushed: resolved.committed }",
    ),
    "Pushed",
  );

  rejected(
    "a merge resolved in something other than the pull request's worktree",
    resolveConflictsWith(
      "base: trigger.base, worktree: worktree }",
      "base: trigger.base, worktree: trigger.branch }",
    ),
    "WorktreePath",
  );

  rejected(
    "a follow-up linked by the merged pull request's number",
    postMergeWith("followUp: filed", "followUp: trigger.pr"),
    "IssueNumber",
  );

  rejected(
    "CI watched on the base branch's name rather than the merge commit",
    postMergeWith(
      "use: merged.awaitCi\n    in: { pr: trigger.pr, sha: trigger.sha",
      "use: merged.awaitCi\n    in: { pr: trigger.pr, sha: trigger.base",
    ),
    "CommitSha",
  );

  rejected(
    "a follow-up filed for CI that wasn't red",
    postMergeWith("            in: { ci: red }", "            in: { ci: closes }"),
    "failedRuns",
  );

  rejected(
    "a re-check of something other than an earlier review",
    reReviewWith(
      "in: { pr: trigger.pr, review: own }",
      "in: { pr: trigger.pr, review: trigger.pr }",
    ),
    "Resumable",
  );

  rejected(
    "a merge a re-check didn't approve",
    reReviewWith("approved: approval.approved", "approved: recheck.verdict"),
    "Approved",
  );

  rejected(
    "a branch where a worktree goes",
    wiring(implement, "agent", "worktree", "claim.branch"),
    "WorktreePath",
  );

  rejected(
    "a pull request's number where an issue's goes",
    wiring(implement, "done", "issue", "opened.number"),
    "IssueNumber",
  );

  rejected(
    "base and branch swapped",
    wiring(wiring(implement, "push", "branch", "claim.base"), "push", "base", "claim.branch"),
    "BranchName",
  );

  rejected(
    "an output a block doesn't have",
    wiring(implement, "worktree", "branch", "claim.ref"),
    "ref",
  );

  rejected(
    "a push that nothing committed for",
    wiring(implement, "push", "committed", "claim.branch"),
    "Committed",
  );

  rejected(
    "a pull request that nothing pushed for",
    wiring(implement, "opened", "pushed", "agent.committed"),
    "Pushed",
  );

  rejected(
    "the failure context kept from the wrong number",
    { ...implement, failureContext: { pr: ["claim.branch"] } },
    "PullRequestNumber",
  );

  rejected(
    "a failure a block can't raise, overridden",
    changing(implement, "worktree", (step) => ({ ...step, failure: { CiTimedOut: "person" } })),
    "CiTimedOut",
  );

  rejected(
    "a disposition there isn't",
    changing(implement, "worktree", (step) => ({ ...step, failure: { StepFailed: "ignore" } })),
    "ignore",
  );

  rejected(
    "a merge with no approval",
    {
      ...review,
      steps: [
        {
          id: "land",
          use: "pr.land",
          in: { pr: "trigger.pr", approved: "trigger.pr" },
          with: { method: "squash" },
        },
      ],
    },
    "Approved",
  );

  // A team's to choose: the types don't say otherwise.
  effect(
    "leaves the local gate and CI to the team",
    () =>
      Effect.gen(function* () {
        expect(yield* compileErrors(without(implement, "gate"))).toEqual([]);
        expect(yield* compileErrors(without(implement, "ci"))).toEqual([]);
      }),
    TIMEOUT,
  );
});

describe("a document with a loop and lanes", () => {
  const TIMEOUT = 120_000;

  const epic = documentOf(EPIC_DOCUMENT);

  // The document with every step, however deep, changed.
  const everywhere = (
    steps: ReadonlyArray<Step>,
    change: (step: Step) => Step,
  ): ReadonlyArray<Step> =>
    steps.map((step) => {
      const changed = change(step);

      if (Compose.isRepeat(changed)) {
        return {
          ...changed,
          repeat: { ...changed.repeat, steps: everywhere(changed.repeat.steps, change) },
        };
      }

      if (Compose.isForEach(changed)) {
        return { ...changed, steps: everywhere(changed.steps, change) };
      }

      if (Compose.isUse(changed)) {
        return {
          ...changed,
          on: Object.fromEntries(
            Object.entries(changed.on ?? {}).map(([outcome, branch]) => [
              outcome,
              { ...branch, steps: everywhere(branch.steps, change) },
            ]),
          ),
        };
      }

      return changed;
    });

  const editing = (id: string, change: (step: UseStep) => UseStep) => ({
    ...epic,
    steps: everywhere(epic.steps, (step) => {
      if (Compose.isUse(step) && step.id === id) {
        return change(step);
      }

      return step;
    }),
  });

  const unwired = (id: string, input: string) =>
    editing(id, (step) => ({
      ...step,
      in: Object.fromEntries(Object.entries(step.in ?? {}).filter(([key]) => key !== input)),
    }));

  test("finds nothing wrong with the epic document", () => {
    expect(Compose.check(epic)).toEqual([]);
  });

  test("refuses a loop with no end", () => {
    const endless = editing("closed", (step) => ({
      ...step,
      on: { finished: { steps: [] } },
    }));

    expect(messages(endless)).toContain("no round ends this loop");
  });

  test("refuses a way round a loop that neither waits nor changes anything", () => {
    const spinning = editing("ready", (step) => ({
      ...step,
      on: { none: { as: "waiting", steps: [{ next: { tasks: "waiting" } }] } },
    }));

    expect(messages(spinning)).toEqual([
      "this round neither waits nor changes anything, so the loop would spin",
    ]);
  });

  test("counts a change as going round: an outcome that moved something is no spin", () => {
    expect(messages(epic)).not.toContain(
      "this round neither waits nor changes anything, so the loop would spin",
    );
  });

  // The document with a step, of any kind, changed wherever it is.
  const editingAny = (id: string, change: (step: Step) => Step) => ({
    ...epic,
    steps: everywhere(epic.steps, (step) => {
      if ("id" in step && step.id === id) {
        return change(step);
      }

      return step;
    }),
  });

  // The document with these steps first in each round, or first in each lane.
  const leading = (where: "round" | "lane", added: ReadonlyArray<Step>) => ({
    ...epic,
    steps: everywhere(epic.steps, (step) => {
      if (where === "round" && Compose.isRepeat(step)) {
        return { ...step, repeat: { ...step.repeat, steps: [...added, ...step.repeat.steps] } };
      }

      if (where === "lane" && Compose.isForEach(step)) {
        return { ...step, steps: [...added, ...step.steps] };
      }

      return step;
    }),
  });

  const roundSteps = (doc: Doc) =>
    doc.steps.filter(Compose.isRepeat).flatMap((step) => step.repeat.steps);

  const withRound = (steps: ReadonlyArray<Step>) => ({
    ...epic,
    steps: epic.steps.map((step) => {
      if (Compose.isRepeat(step)) {
        return { ...step, repeat: { ...step.repeat, steps } };
      }

      return step;
    }),
  });

  const SPINS = "this round neither waits nor changes anything, so the loop would spin";

  const RUNS_OFF = "a round can run off its steps: end it, or go on with next";

  describe("refuses every way round a loop that neither waits nor changes anything", () => {
    test("a round that runs off its steps, which also loses what it changed", () => {
      expect(messages(withRound(roundSteps(epic).slice(0, -1)))).toEqual([RUNS_OFF]);
    });

    test("a round of steps that neither wait nor change anything, and never go on", () => {
      const reading = roundSteps(epic).filter(
        (step) => named(step, "progress") || named(step, "closed"),
      );

      expect(messages(withRound(reading))).toEqual([RUNS_OFF]);
    });

    test("a wait that may not run", () => {
      const sometimes = editing("parked", (step) => ({ ...step, if: "ships.value" }));

      expect(messages(sometimes)).toEqual([SPINS]);
    });

    test("lanes that may be none: nothing started is no change", () => {
      const nothingStarted = editing("ready", (step) => ({ ...step, on: { none: { steps: [] } } }));

      expect(messages(nothingStarted)).toEqual([SPINS]);
    });
  });

  describe("takes only names for what a `first` or a `forEach` declares", () => {
    test("a first's id that isn't a name", () => {
      const injected = editingAny("latest", (step) => ({
        ...step,
        id: "x = 1; console.log('injected'); const y",
      }));

      expect(messages(injected)[0]).toBe(
        "x = 1; console.log('injected'); const y can't name a step",
      );
    });

    test("a first's id another step has", () => {
      const twice = editingAny("latest", (step) => ({ ...step, id: "progress" }));

      expect(messages(twice)).toContain("progress is already a step here");
    });

    test("a first of nothing", () => {
      const empty = editingAny("latest", (step) => ({ ...step, first: [] }));

      expect(messages(empty)).toContain("must name at least one output");
    });

    test("a forEach's id or item that isn't a name, or is one the flow uses", () => {
      const badId = editingAny("started", (step) => ({ ...step, id: "a b" }));
      expect(messages(badId)).toContain("a b can't name a step");

      const reserved = editingAny("started", (step) => ({ ...step, as: "item" }));
      expect(messages(reserved)).toContain("item can't name each item");

      const taken = editingAny("started", (step) => ({ ...step, as: "progress" }));
      expect(messages(taken)).toContain("progress is already a step here");
    });
  });

  // A run resumes by step names, so a second round, or a second lane, would
  // get the first's saved result instead of doing the work.
  describe("refuses a block whose step names would be the same in each round or lane", () => {
    test("a block with no lane beside others", () => {
      const pushed = leading("lane", [
        {
          id: "pushedEarly",
          use: "branch.push",
          in: { worktree: "task.lane", branch: "task.lane", base: "task.base", committed: "task" },
        },
      ]);

      expect(messages(pushed)).toContain(
        "branch.push names its steps the same in every lane, so it can't run beside others",
      );
    });

    test("a block that carries a round, beside others", () => {
      const read = leading("lane", [
        { id: "again", use: "epic.progress", in: { epic: "trigger.epic", round: "round" } },
      ]);

      expect(messages(read)).toContain(
        "epic.progress names its steps the same in every lane, so it can't run beside others",
      );
    });

    test("a block with no round in a repeat", () => {
      const atOnce = leading("round", [{ id: "again", use: "epic.atOnce" }]);

      expect(messages(atOnce)).toEqual([
        "epic.atOnce names its steps the same in every round, so it can't run in a repeat",
      ]);

      const prepared = leading("round", [
        { id: "early", use: "worktree.prepare", in: { branch: "progress", base: "progress" } },
      ]);

      expect(messages(prepared)).toContain(
        "worktree.prepare names its steps the same in every round, so it can't run in a repeat",
      );
    });

    test("a block that takes a round, given a fixed one", () => {
      const fixed = editing("progress", (step) => ({
        ...step,
        in: { epic: "trigger.epic" },
        with: { round: 1 },
      }));

      expect(messages(fixed)).toContain(
        "epic.progress runs in every round here, and must take round",
      );
    });

    // Review.round names its steps by its round, so a fixed one would replay the
    // first round's verdict in every round after it.
    describe("a review in a loop", () => {
      const reviewing = (inputs: Pick<UseStep, "in" | "with">): Doc => ({
        ...review,
        steps: [
          {
            id: "rounds",
            repeat: {
              state: {},
              steps: [
                {
                  id: "verdict",
                  use: "review.round",
                  ...inputs,
                  on: {
                    approve: { steps: [{ end: "done" }] },
                    changes: {
                      steps: [
                        {
                          id: "parked",
                          use: "epic.park",
                          in: { round: "round" },
                          with: { lookAgainAfter: "1 day" },
                        },
                        { next: {} },
                      ],
                    },
                  },
                },
              ],
            },
          },
        ],
      });

      test("takes its round from the loop", () => {
        expect(
          messages(
            reviewing({ in: { pr: "trigger.pr", round: "round" }, with: { role: "reviewer" } }),
          ),
        ).toEqual([]);
      });

      test("refuses a fixed round, which would review once for every round", () => {
        expect(
          messages(reviewing({ in: { pr: "trigger.pr" }, with: { round: 1, role: "reviewer" } })),
        ).toEqual(["review.round runs in every round here, and must take round"]);
      });

      test("still takes a fixed round for a single review", () => {
        expect(Compose.check(review)).toEqual([]);
      });
    });

    test("lets a block that runs no step go anywhere", () => {
      const noted = leading("lane", [
        {
          id: "ended",
          use: "epic.recordEndings",
          in: { tasks: "state.tasks", endings: "ready.starts" },
        },
      ]);

      expect(messages(noted)).toEqual([]);
    });
  });

  test("refuses next outside a loop", () => {
    expect(messages({ ...withSteps(implement, [{ next: {} }]), failureContext: {} })).toEqual([
      "next means something only inside a repeat",
    ]);
  });

  test("wants a block beside others to name its lane, or lanes' step names would collide", () => {
    expect(messages(unwired("gate", "lane"))).toEqual([
      "gate.local runs beside others here, and must name its lane",
    ]);
  });

  test("keeps a lane's item, and what its steps give, to the lane", () => {
    const leaked = editing("recorded", (step) => ({
      ...step,
      in: { ...step.in, endings: "task" },
    }));

    expect(messages(leaked)[0]).toContain("task is not available here");
  });

  test("keeps round and state to the loop", () => {
    expect(messages(wiring(implement, "gate", "worktree", "round"))[0]).toContain(
      "round is not available here",
    );
  });

  test("knows the loop states and lane scopes there are", () => {
    const unknownState = {
      ...epic,
      steps: everywhere(epic.steps, (step) => {
        if (Compose.isRepeat(step)) {
          return { ...step, repeat: { ...step.repeat, state: { tasks: "nothing" } } };
        }

        return step;
      }),
    };

    expect(messages(unknownState)[0]).toContain("must start from one of epic.tasks");

    const unknownScope = {
      ...epic,
      steps: everywhere(epic.steps, (step) => {
        if (Compose.isForEach(step)) {
          return { ...step, scope: "nothing" };
        }

        return step;
      }),
    };

    expect(messages(unknownScope)).toEqual(["must be one of epic.task"]);
  });

  const rejected = (name: string, doc: Doc, says: string) => {
    effect(
      name,
      () =>
        Effect.gen(function* () {
          expect(Compose.check(doc)).toEqual([]);
          expect((yield* compileErrors(doc)).join("\n")).toContain(says);
        }),
      TIMEOUT,
    );
  };

  effect(
    "compiles the epic document",
    () =>
      Effect.gen(function* () {
        expect(yield* compileErrors(epic)).toEqual([]);
      }),
    TIMEOUT,
  );

  // A step that ran only sometimes has no output to read without `first`.
  rejected(
    "a conditional step's output read as though it always ran",
    editing("ready", (step) => ({ ...step, in: { ...step.in, tasks: "landed.tasks" } })),
    "tasks",
  );

  // Ending a round without recording how its lanes ended loses the hand-back rule (#249).
  rejected(
    "a round that goes on without recording how its lanes ended",
    {
      ...epic,
      steps: everywhere(epic.steps, (step) => {
        if (Compose.isRepeat(step)) {
          return {
            ...step,
            repeat: {
              ...step.repeat,
              steps: step.repeat.steps
                .filter((each) => !(Compose.isUse(each) && each.id === "recorded"))
                .map((each) => {
                  if ("next" in each) {
                    return { next: { tasks: "ready.started", stack: "latest.stack" } };
                  }

                  return each;
                }),
            },
          };
        }

        return step;
      }),
    },
    "started",
  );

  rejected(
    "the wrong state for a block",
    editing("carried", (step) => ({ ...step, in: { ...step.in, stack: "state.tasks" } })),
    "recorded",
  );

  rejected(
    "an issue's number where the epic's goes",
    editing("progress", (step) => ({ ...step, in: { ...step.in, epic: "round" } })),
    "EpicNumber",
  );

  // `if` names a boolean, which a document can't test the truth of otherwise.
  rejected(
    "an if on what isn't a boolean",
    editing("landed", (step) => ({ ...step, if: "progress.layers" })),
    "no overlap",
  );

  rejected(
    "a publish from a lane that nothing committed in",
    editing("published", (step) => ({ ...step, in: { ...step.in, committed: "task.lane" } })),
    "Committed",
  );
});

// How the rounds decide what to start, which a run reaches only when a person
// hands a task back between two of them (#249).
describe("the blocks that decide what an epic starts", () => {
  const ready = (number: number): Epic.Layer => ({
    number,
    title: `Task ${number}`,
    state: "ready",
    base: "main",
  });

  const reading = (layers: ReadonlyArray<Epic.Layer>): Epic.Progress => ({
    layers,
    fingerprint: "",
  });

  const after = (attempts: ReadonlyArray<readonly [number, number]>) => ({
    ...Blocks.loopStates["epic.tasks"](),
    attempts: new Map(attempts),
  });

  const lanes = (tasks: EpicBlocks.TaskState, progress: Epic.Progress) =>
    Blocks.catalogue["epic.startable"]
      .run({ progress, tasks })
      .pipe(Effect.map((planned) => planned.starts.map((start) => String(start.lane))));

  effect("starts a task it never attempted", () =>
    Effect.gen(function* () {
      expect(yield* lanes(after([]), reading([ready(10)]))).toEqual(["task-10"]);
    }),
  );

  effect("leaves a task still ready after its attempt, as one another run holds", () =>
    Effect.gen(function* () {
      expect(yield* lanes(after([[10, 1]]), reading([ready(10)]))).toEqual([]);
    }),
  );

  effect("starts it again when its attempt ended with a person, read ready or not", () =>
    Effect.gen(function* () {
      const { tasks } = yield* Blocks.catalogue["epic.recordEndings"].run({
        tasks: { started: after([[10, 1]]) },
        endings: [{ issue: 10, withPerson: true }],
      });

      expect(yield* lanes(tasks, reading([ready(10)]))).toEqual(["task-10-2"]);
    }),
  );

  effect("doesn't start it again when its attempt ended otherwise", () =>
    Effect.gen(function* () {
      const { tasks } = yield* Blocks.catalogue["epic.recordEndings"].run({
        tasks: { started: after([[10, 1]]) },
        endings: [{ issue: 10, withPerson: false }],
      });

      expect(yield* lanes(tasks, reading([ready(10)]))).toEqual([]);
    }),
  );
});

describe("the order a document's blocks run in", () => {
  const epic = documentOf(EPIC_DOCUMENT);

  // A list of steps with the step moved to just before another.
  const movedIn = (steps: ReadonlyArray<Step>, id: string, before: string) => {
    const moving = steps.filter((step) => named(step, id));
    const rest = steps.filter((step) => !named(step, id));
    const at = rest.findIndex((step) => named(step, before));

    return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  };

  // The epic with its round's steps changed.
  const round = (change: (steps: ReadonlyArray<Step>) => ReadonlyArray<Step>) => ({
    ...epic,
    steps: epic.steps.map((step) => {
      if (Compose.isRepeat(step)) {
        return { ...step, repeat: { ...step.repeat, steps: change(step.repeat.steps) } };
      }

      return step;
    }),
  });

  // The epic with its lane's steps changed.
  const lane = (change: (steps: ReadonlyArray<Step>) => ReadonlyArray<Step>) =>
    round((steps) =>
      steps.map((step) => {
        if (Compose.isForEach(step)) {
          return { ...step, steps: change(step.steps) };
        }

        return step;
      }),
    );

  test("finds nothing wrong with the recipes' documents", () => {
    expect(Compose.check(implement)).toEqual([]);
    expect(Compose.check(review)).toEqual([]);
    expect(Compose.check(epic)).toEqual([]);
  });

  test("refuses the local gate after what it should have stopped", () => {
    expect(messages(moved(implement, "gate", "ci")).join("\n")).toContain(
      "gate.local must run before pr.open, and this runs after it",
    );
  });

  test("refuses the local gate before the agent has worked", () => {
    expect(messages(moved(implement, "gate", "agent"))).toContain(
      "agent.implement must run before gate.local, and this runs after it",
    );
  });

  test("refuses a hand-off before CI", () => {
    const handedOffFirst = withSteps(implement, [
      ...implement.steps.filter((step) => !named(step, "ci") && Compose.isUse(step)),
      ...stepOf(implement, "ci"),
    ]);

    expect(messages(handedOffFirst)).toContain(
      "ci.waitAndFix must run before issue.handOff, and this runs after it",
    );
  });

  test("refuses a pull request that is never handed off, on every way to the end", () => {
    expect(messages(without(implement, "done"))).toContain(
      "a way through pr.open finishes here with hand-off not done",
    );
  });

  test("refuses an adopted pull request that is never handed off", () => {
    const dropped = changing(implement, "claim", (step) => ({
      ...step,
      on: {
        adopted: { as: "adopted", steps: [{ end: "done" }] },
      },
    }));

    expect(messages(dropped)).toContain(
      "a way through issue.claim finishes here with hand-off not done",
    );
  });

  test("excuses a way that ends with a person", () => {
    const toPerson = withSteps(implement, [
      ...implement.steps.filter((step) => Compose.isUse(step) && !named(step, "done")),
      { end: "needs-human", reason: "opened.url" },
    ]);

    expect(Compose.check(toPerson)).toEqual([]);
  });

  test("refuses a lane that keeps its claim after its questions", () => {
    const keeps = lane((steps) =>
      steps.map((step) => {
        if (Compose.isUse(step) && step.id === "agent") {
          return {
            ...step,
            on: {
              "needs-clarification": {
                as: "questions",
                steps: [
                  {
                    id: "asked",
                    use: "issue.askClarification",
                    in: { issue: "task.issue", outcome: "questions", lane: "task.lane" },
                  },
                  { end: "done" as const },
                ],
              },
            },
          };
        }

        return step;
      }),
    );

    expect(messages(keeps)).toContain(
      "a way through issue.askClarification finishes here with release-claim not done",
    );
  });

  test("refuses questions that are never asked", () => {
    const unasked = changing(implement, "agent", (step) => ({
      ...step,
      on: { "needs-clarification": { as: "questions", steps: [{ end: "done" }] } },
    }));

    expect(messages(unasked)).toEqual([
      "a way through agent.implement finishes here with ask-questions not done",
    ]);
  });

  test("refuses working through an epic it never claimed", () => {
    const unclaimed = { ...epic, steps: epic.steps.filter((step) => !named(step, "claimed")) };

    expect(messages(unclaimed)).toContain("epic.progress needs epic.claim to have run first");
  });

  test("refuses starting tasks before the stack is up to date", () => {
    const early = round((steps) => movedIn(steps, "ready", "carried"));

    expect(messages(early).join("\n")).toContain("stack.carryUp must run before epic.startable");
  });

  test("refuses finishing before the last status is posted", () => {
    const early = round((steps) => movedIn(steps, "closed", "status"));

    expect(messages(early).join("\n")).toContain("epic.postStatus must run before epic.finished");
  });

  test("sees a hand-off that may not run as one that may not happen", () => {
    const maybe = changing(implement, "done", (step) => ({ ...step, if: "agent.committed" }));

    expect(messages(maybe)).toContain("a way through pr.open finishes here with hand-off not done");
  });

  test("sees order down every branch", () => {
    // Removing a hand-off from one branch alone is still caught.
    const oneBranch = changing(implement, "claim", (step) => ({
      ...step,
      on: {
        adopted: {
          as: "adopted",
          steps: [
            {
              id: "adoptedCi",
              use: "ci.waitPreparing",
              in: { pr: "adopted.number", branch: "claim.branch", base: "claim.base" },
            },
            { end: "done" },
          ],
        },
      },
    }));

    expect(messages(oneBranch)).toEqual([
      "a way through issue.claim finishes here with hand-off not done",
    ]);
  });

  // The implement document with the pull request opened in a loop's round: a
  // round that isn't approved opens one and goes on, and an approved round ends.
  const looped = (approved: ReadonlyArray<Step>): Doc => ({
    ...implement,
    steps: [
      ...implement.steps.filter(
        (step) =>
          Compose.isUse(step) && ["claim", "worktree", "agent", "gate", "push"].includes(step.id),
      ),
      {
        id: "rounds",
        repeat: {
          state: {},
          steps: [
            {
              id: "review",
              use: "review.round",
              in: { pr: "trigger.issue", round: "round" },
              with: { role: "reviewer" },
              on: { approve: { as: "verdict", steps: approved } },
            },
            {
              id: "opened",
              use: "pr.open",
              in: {
                issue: "trigger.issue",
                outcome: "agent.outcome",
                queued: "trigger.queued",
                base: "claim.base",
                pushed: "push.pushed",
              },
            },
            { next: {} },
          ],
        },
      },
    ],
  });

  test("carries what a round left to do into the next round", () => {
    expect(Compose.check(looped([{ end: "done" }]))).toContainEqual({
      path: "steps[5].repeat.steps[0].on.approve.steps[0]",
      message: "a way through pr.open finishes here with hand-off not done",
    });
  });

  test("lets a later round do what an earlier one left", () => {
    const handedOff = looped([
      {
        id: "done",
        use: "issue.handOff",
        in: { issue: "trigger.issue", pr: "opened", outcome: "agent.outcome" },
      },
      { end: "done" },
    ]);

    expect(messages(handedOff).filter((message) => message.includes("not done"))).toEqual([]);
  });

  test("goes round a loop with nothing new only once", () => {
    const spinning = looped([{ end: "done" }]);

    const once = {
      ...spinning,
      steps: spinning.steps.map((step) => {
        if (Compose.isRepeat(step)) {
          return { ...step, repeat: { ...step.repeat, steps: [{ next: {} }] } };
        }

        return step;
      }),
    };

    expect(messages(once)).toContain("no round ends this loop");
  });

  // Each step may run or not, so 2^40 ways, but few states: walked once each, it
  // takes milliseconds, well inside a second.
  effect("walks a long chain of steps that may not run in time", () =>
    Effect.gen(function* () {
      const chain: ReadonlyArray<Step> = Array.from({ length: 40 }, (_, index) => ({
        id: `noted${index}`,
        use: "epic.noteWaits",
        in: { progress: "progress", tasks: "state.tasks" },
        if: "ships.value",
      }));

      const at = (steps: ReadonlyArray<Step>) => steps.findIndex((step) => named(step, "closed"));

      const chained = round((steps) => [
        ...steps.slice(0, at(steps)),
        ...chain,
        ...steps.slice(at(steps)),
      ]);

      const started = yield* Clock.currentTimeMillis;

      expect(Compose.check(chained)).toEqual([]);
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1000);
    }),
  );

  // A team's to choose, and no order breaks them.
  test("leaves a team's choices alone", () => {
    expect(Compose.check(without(implement, "gate"))).toEqual([]);
    expect(Compose.check(without(implement, "ci"))).toEqual([]);
    expect(Compose.check(lane((steps) => steps.filter((step) => !named(step, "gate"))))).toEqual(
      [],
    );
    expect(Compose.check(lane((steps) => steps.filter((step) => !named(step, "ci"))))).toEqual([]);
  });

  test("names only blocks that exist", () => {
    const names = Object.keys(Blocks.catalogue);

    for (const block of Object.values(Blocks.catalogue)) {
      for (const other of [...block.before, ...block.needs]) {
        expect(names).toContain(other);
      }
    }
  });

  test("leaves nothing to do that no block does", () => {
    const blocks = Object.values(Blocks.catalogue);
    const closed = blocks.flatMap((block): ReadonlyArray<string> => block.closes);

    for (const block of blocks) {
      for (const what of [...block.opens, ...Object.values(block.opensOn).flat()]) {
        expect(closed).toContain(what);
      }
    }
  });
});

describe("the catalogue and the sources", () => {
  const block = (name: string) => ({ name });

  test("refuses a name defined twice, naming both definitions", () => {
    expect(() =>
      Blocks.gather("block", "epic-blocks.ts", { "issue.claim": block("issue.claim") }).and(
        "blocks.ts",
        { "issue.claim": block("issue.claim") },
      ),
    ).toThrow('block "issue.claim" is defined twice: in epic-blocks.ts and in blocks.ts');
  });

  test("refuses a name defined twice across more than two files", () => {
    expect(() =>
      Blocks.gather("source", "epic-blocks.ts", { "epic.queued": block("epic.queued") })
        .and("blocks.ts", { "issues.queued": block("issues.queued") })
        .and("plan-blocks.ts", { "epic.queued": block("epic.queued") }),
    ).toThrow('source "epic.queued" is defined twice: in epic-blocks.ts and in plan-blocks.ts');
  });

  test("refuses an entry kept under a key other than its name", () => {
    expect(() =>
      Blocks.gather("block", "blocks.ts", { "issue.claim": block("issue.adopt") }),
    ).toThrow('block "issue.claim" in blocks.ts is named "issue.adopt"; its key must be its name');
  });

  test("keeps every entry of every file", () => {
    const gathered = Blocks.gather("block", "a.ts", { one: block("one") }).and("b.ts", {
      two: block("two"),
    }).entries;

    expect(Object.keys(gathered)).toEqual(["one", "two"]);
    expect(gathered.two.name).toBe("two");
  });

  test("keeps each block and each source under its own name", () => {
    for (const [key, entry] of Object.entries(Blocks.catalogue)) {
      expect(entry.name).toBe(key);
    }

    for (const [key, entry] of Object.entries(Blocks.sources)) {
      expect(entry.name).toBe(key);
    }
  });
});

describe("Compose.describe", () => {
  const SaidBlock = Schema.Struct({
    name: Schema.String,
    about: Schema.String,
    inputs: Schema.Array(Schema.Struct({ name: Schema.String, kind: Schema.String })),
    outcomes: Schema.Array(Schema.Struct({ name: Schema.String, binds: Schema.String })),
  });

  const said = Schema.decodeUnknownSync(
    Schema.Struct({
      subjects: Schema.Array(Schema.Struct({ name: Schema.String })),
      sources: Schema.Array(Schema.Struct({ name: Schema.String, about: Schema.String })),
      blocks: Schema.Array(SaidBlock),
    }),
  )(Compose.describe());

  test("lists every block, source and subject there is", () => {
    expect(said.blocks.map((block) => block.name).toSorted()).toEqual(
      Object.keys(Blocks.catalogue).toSorted(),
    );
    expect(said.sources.map((source) => source.name).toSorted()).toEqual(
      Object.keys(Blocks.sources).toSorted(),
    );
    expect(said.subjects.map((subject) => subject.name).toSorted()).toEqual(
      Object.keys(Blocks.subjects).toSorted(),
    );
  });

  test("shows the format", () => {
    const { format } = Schema.decodeUnknownSync(Schema.Struct({ format: Schema.String }))(
      Compose.describe(),
    );

    for (const part of [
      "flow:",
      "subject:",
      "trigger:",
      "start:",
      "steps:",
      "in:",
      "with:",
      "as:",
      "end:",
    ]) {
      expect(format).toContain(part);
    }
  });

  test("says which subjects a person can start a flow on", () => {
    const { subjects } = Schema.decodeUnknownSync(
      Schema.Struct({
        subjects: Schema.Array(Schema.Struct({ name: Schema.String, start: Schema.Boolean })),
      }),
    )(Compose.describe());

    expect(subjects.filter((subject) => subject.start).map((subject) => subject.name)).toEqual([
      "issue",
    ]);
  });

  test("says what each block does, and each of its inputs and outcomes", () => {
    for (const block of said.blocks) {
      expect(`${block.name}: ${block.about}`).not.toBe(`${block.name}: `);

      for (const input of block.inputs) {
        expect(`${block.name}.${input.name}: ${input.kind}`).not.toBe(
          `${block.name}.${input.name}: `,
        );
      }

      for (const outcome of block.outcomes) {
        expect(`${block.name}.${outcome.name}: ${outcome.binds}`).not.toBe(
          `${block.name}.${outcome.name}: `,
        );
      }
    }
  });

  // Keeps a block's listing to what it has: `bun run check` runs this file.
  test("can't name what a block doesn't have", () => {
    const shared = {
      name: "test.listing",
      about: "",
      inputs: { issue: "required" },
      run: (_: { readonly issue: number }) => Effect.succeed({ branch: "b" }),
      failures: {},
      outcomes: {},
      mustRoute: [],
      contributes: {},
    } as const;

    const right = Blocks.defineBlock({
      ...shared,
      inputKinds: { issue: "" },
      outputKinds: { branch: "" },
      outcomeKinds: {},
    });

    const wrongInput = Blocks.defineBlock({
      ...shared,
      // @ts-expect-error -- the test: the block takes issue, not pr.
      inputKinds: { pr: "" },
      outputKinds: { branch: "" },
      outcomeKinds: {},
    });

    const wrongOutput = Blocks.defineBlock({
      ...shared,
      inputKinds: { issue: "" },
      // @ts-expect-error -- the test: the block gives branch, not base.
      outputKinds: { base: "" },
      outcomeKinds: {},
    });

    expect([right.name, wrongInput.name, wrongOutput.name]).toHaveLength(3);
  });
});

describe("generate", () => {
  test("writes a flow that says where it came from, on the SDK alone", () => {
    const flow = generated(implement);
    expect(flow).toStartWith("// Generated from the flow document implement;");
    expect(flow).toContain('from "@chernabog/sdk"');
    expect(flow).toContain("failureContext.pr = Option.some(opened.number);");
    expect(flow).toContain("failureContext.pr = Option.some(adopted.number);");
  });

  test("is the same flow for the same document", () => {
    expect(generated(implement)).toBe(generated(documentOf(IMPLEMENT_DOCUMENT)));
  });

  test("names where a flow imports the SDK from when asked", () => {
    expect(Result.getOrThrow(Compose.generate(implement, "../sdk.ts"))).toContain(
      'from "../sdk.ts"',
    );
  });
});

describe("a block's failure table", () => {
  const raising = <E extends { readonly _tag: string }>(error: E, failures: Blocks.Failures<E>) =>
    Blocks.defineBlock({
      name: "test.block",
      about: "",
      inputKinds: {},
      outputKinds: "",
      outcomeKinds: {},
      inputs: {},
      run: (_: Record<never, never>) => Effect.fail(error),
      failures,
      outcomes: {},
      mustRoute: [],
      contributes: {},
    });

  const reasonOf = (failure: FlowError | Blocks.ToPerson) =>
    Option.getOrElse(
      Option.liftPredicate(failure, (each) => each instanceof Blocks.ToPerson).pipe(
        Option.map((each) => each.reason),
      ),
      () => "not on its way to a person",
    );

  effect("goes to a person with the error's reason", () =>
    Effect.gen(function* () {
      const said = [
        yield* raising(new NeedsHuman({ reason: "why" }), { NeedsHuman: "person" })
          .run({})
          .pipe(Effect.flip),
        yield* raising(new StepFailed({ step: "push", message: "no" }), { StepFailed: "person" })
          .run({})
          .pipe(Effect.flip),
        yield* raising(new NothingCommitted({ branch: "auto/issue-3" }), {
          NothingCommitted: "person",
        })
          .run({})
          .pipe(Effect.flip),
        yield* raising(new PullRequestClosed({ pullRequest: 7, state: "closed" }), {
          PullRequestClosed: "person",
        })
          .run({})
          .pipe(Effect.flip),
      ].map(reasonOf);

      expect(said.slice(0, 3)).toEqual([
        "why",
        "push: no",
        "the agent finished without committing anything on auto/issue-3",
      ]);
      expect(said[3]).toContain("#7");
    }),
  );

  effect("told stays a person's without telling them again", () =>
    Effect.gen(function* () {
      const error = new NeedsHuman({ reason: "already said" });
      expect(yield* raising(error, { NeedsHuman: "told" }).run({}).pipe(Effect.flip)).toBe(error);
    }),
  );

  effect("skip ends the scope skipped, with the error's reason", () =>
    Effect.gen(function* () {
      const gone = new NotFound({ what: "issue 3" });
      const failure = yield* raising(gone, { NotFound: "skip" }).run({}).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(Skip);

      const held = new Skip({ reason: "held" });
      expect(yield* raising(held, { Skip: "skip" }).run({}).pipe(Effect.flip)).toBe(held);
    }),
  );

  effect("fail ends the scope failed, naming the block for an error of no step", () =>
    Effect.gen(function* () {
      const failure = yield* raising(new NeedsHuman({ reason: "x" }), { NeedsHuman: "fail" })
        .run({})
        .pipe(Effect.flip);

      expect(failure).toBeInstanceOf(StepFailed);

      const stepFailed = new StepFailed({ step: "push", message: "no" });

      expect(yield* raising(stepFailed, { StepFailed: "fail" }).run({}).pipe(Effect.flip)).toBe(
        stepFailed,
      );
    }),
  );

  effect("a flow overrides what a block declares", () =>
    Effect.gen(function* () {
      const error = new NeedsHuman({ reason: "x" });

      const failure = yield* raising(error, { NeedsHuman: "told" })
        .run({}, { NeedsHuman: "skip" })
        .pipe(Effect.flip);

      expect(failure).toBeInstanceOf(Skip);
    }),
  );

  // A stale or missing entry in a table is a compile error, which `bun run
  // check` runs on this file.
  test("must name exactly the errors the block can raise", () => {
    const pushing = {
      about: "",
      inputKinds: { issue: "" },
      outputKinds: "",
      outcomeKinds: {},
      inputs: { issue: "required" },
      run: (input: { readonly issue: number }) =>
        Implement.push("push", "/tmp/w", `auto/issue-${input.issue}`),
      outcomes: {},
      mustRoute: [],
      contributes: {},
    } as const;

    const complete = Blocks.defineBlock({
      ...pushing,
      name: "complete",
      failures: {
        NeedsHuman: "person",
        NothingCommitted: "person",
        PushRejected: "person",
        Skip: "skip",
        StepFailed: "person",
      },
    });

    const missing = Blocks.defineBlock({
      ...pushing,
      name: "missing",
      // @ts-expect-error -- the test: PushRejected has no disposition.
      failures: {
        NeedsHuman: "person",
        NothingCommitted: "person",
        Skip: "skip",
        StepFailed: "person",
      },
    });

    const stale = Blocks.defineBlock({
      ...pushing,
      name: "stale",
      failures: {
        NeedsHuman: "person",
        NothingCommitted: "person",
        PushRejected: "person",
        Skip: "skip",
        StepFailed: "person",
        // @ts-expect-error -- the test: a push can't time out on CI.
        CiTimedOut: "person",
      },
    });

    expect([complete.name, missing.name, stale.name]).toEqual(["complete", "missing", "stale"]);
  });
});

describe("a document that runs a stage", () => {
  const TIMEOUT = 120_000;

  const staged = documentOf(REVIEW_WITH_STAGE_DOCUMENT);
  const epic = documentOf(EPIC_DOCUMENT);

  const FAILURE = { Skip: "skip", StepFailed: "person" };

  const checked = (doc: Doc) => Compose.check(doc, STAGE_FILES);

  const said = (doc: Doc) => checked(doc).map((problem) => problem.message);

  const stagePaths = (doc: Doc) => checked(doc).map((problem) => problem.path);

  // The document with a step put first.
  const leading = (doc: Doc, step: Step) => withSteps(doc, [step, ...doc.steps]);

  // The epic with a step put first in its round, or in its lanes.
  const inEpic = (where: "round" | "lane", step: Step): Doc => {
    const into = (steps: ReadonlyArray<Step>): ReadonlyArray<Step> =>
      steps.map((each) => {
        if (where === "round" && Compose.isRepeat(each)) {
          return { ...each, repeat: { ...each.repeat, steps: [step, ...into(each.repeat.steps)] } };
        }

        if (where === "lane" && Compose.isForEach(each)) {
          return { ...each, steps: [step, ...each.steps] };
        }

        if (Compose.isRepeat(each)) {
          return { ...each, repeat: { ...each.repeat, steps: into(each.repeat.steps) } };
        }

        if (Compose.isUse(each)) {
          return {
            ...each,
            on: Object.fromEntries(
              Object.entries(each.on ?? {}).map(([outcome, branch]) => [
                outcome,
                { ...branch, steps: into(branch.steps) },
              ]),
            ),
          };
        }

        return each;
      });

    return withSteps(epic, into(epic.steps));
  };

  // The stage step, changed.
  const changingStage = (doc: Doc, change: (step: Compose.StageStep) => Compose.StageStep): Doc =>
    withSteps(
      doc,
      doc.steps.map((step) => {
        if (Compose.isStage(step)) {
          return change(step);
        }

        return step;
      }),
    );

  test("reads a step that names a stage", () => {
    const read = Compose.read({
      flow: "x",
      subject: "pull-request",
      trigger: [],
      steps: [{ id: "a", stage: "which-pr", in: { pr: "trigger.pr" }, failure: FAILURE }],
    });

    expect(Result.isSuccess(read)).toBe(true);
  });

  test("refuses a step that names a block and a stage", () => {
    const read = Compose.read({
      flow: "x",
      subject: "pull-request",
      trigger: [],
      steps: [{ id: "a", use: "review.round", stage: "which-pr" }],
    });

    expect(Result.isFailure(read) && read.failure).toEqual([
      { path: "steps[0]", message: "uses a block or runs a stage, not both" },
    ]);
  });

  test("finds nothing wrong with a stage wired correctly", () => {
    expect(checked(staged)).toEqual([]);
  });

  test("refuses a stage the repo doesn't have", () => {
    expect(Compose.check(staged)).toEqual([
      {
        path: "steps[0].stage",
        message: "no stage named which-pr in .chernabog/stages/; there are none",
      },
    ]);

    expect(checked(changingStage(staged, (step) => ({ ...step, stage: "find-work" })))).toEqual([
      {
        path: "steps[0].stage",
        message: "no stage named find-work in .chernabog/stages/; there are count-words, which-pr",
      },
    ]);
  });

  test("names a stage without its extension", () => {
    expect(said(changingStage(staged, (step) => ({ ...step, stage: "which-pr.ts" })))).toEqual([
      "names a stage by its file without the extension: which-pr",
    ]);
  });

  test("refuses a shell stage, whose output has no types", () => {
    expect(checked(changingStage(staged, (step) => ({ ...step, stage: "notify" })))).toEqual([
      {
        path: "steps[0].stage",
        message:
          "notify is a shell stage, whose output has no types: wrap it in an Effect stage, .chernabog/stages/notify.ts, that default-exports defineStage({ name, input, output, run })",
      },
    ]);
  });

  describe("wants what each of a stage's failures means", () => {
    test("with no failure table", () => {
      const unsaid = changingStage(staged, ({ failure: _, ...step }) => step);

      expect(checked(unsaid)).toEqual([
        {
          path: "steps[0].failure",
          message:
            "which-pr can fail with Skip, and this doesn't say what that means: give failure.Skip as person, told, skip or fail",
        },
        {
          path: "steps[0].failure",
          message:
            "which-pr can fail with StepFailed, and this doesn't say what that means: give failure.StepFailed as person, told, skip or fail",
        },
      ]);
    });

    test("with one failure left out", () => {
      const half = changingStage(staged, (step) => ({ ...step, failure: { Skip: "skip" } }));

      expect(stagePaths(half)).toEqual(["steps[0].failure"]);
      expect(said(half)).toEqual([
        "which-pr can fail with StepFailed, and this doesn't say what that means: give failure.StepFailed as person, told, skip or fail",
      ]);
    });

    test("with a failure a stage can't come to, or a disposition there isn't", () => {
      const wrong = changingStage(staged, (step) => ({
        ...step,
        failure: { Skip: "skip", StepFailed: "ignore", NeedsHuman: "told" },
      }));

      expect(checked(wrong)).toEqual([
        { path: "steps[0].failure.StepFailed", message: "must be person, told, skip or fail" },
        {
          path: "steps[0].failure.NeedsHuman",
          message: "a stage fails only with Skip or StepFailed",
        },
      ]);
    });
  });

  test("checks what a stage is wired to", () => {
    const unwired = changingStage(staged, (step) => ({ ...step, in: { pr: "nothing.pr" } }));

    expect(stagePaths(unwired)).toEqual(["steps[0].in.pr"]);
    expect(said(unwired)[0]).toStartWith("nothing is not available here");
  });

  test("refuses an outcome, which a stage has none of", () => {
    const routed = changingStage(staged, (step) => ({
      ...step,
      on: { done: { steps: [{ end: "done" }] } },
    }));

    expect(checked(routed)).toEqual([
      { path: "steps[0].on.done", message: "which-pr comes to nothing to route" },
    ]);
  });

  test("refuses a stage twice on one path, whose step names would collide", () => {
    const twice = leading(staged, {
      id: "first",
      stage: "which-pr",
      in: { pr: "trigger.pr" },
      failure: FAILURE,
    });

    expect(checked(twice)).toEqual([
      {
        path: "steps[1].stage",
        message: "which-pr runs twice on one path, and its step names would collide",
      },
    ]);
  });

  describe("wants a stage in a loop or a lane to carry its round or lane", () => {
    const counted = (wired: { readonly [input: string]: string }): Step => ({
      id: "counted",
      stage: "count-words",
      in: wired,
      failure: FAILURE,
    });

    test("a stage in a loop without its round", () => {
      const roundless = inEpic("round", counted({ text: "trigger.epic" }));

      expect(Compose.check(roundless, STAGE_FILES)).toEqual([
        {
          path: "steps[3].repeat.steps[0].in.round",
          message: "count-words runs in every round here, and must take round",
        },
      ]);
    });

    test("and not with it", () => {
      expect(said(inEpic("round", counted({ text: "trigger.epic", round: "round" })))).toEqual([]);
    });

    test("a stage in a lane without its lane", () => {
      const laneless = inEpic("lane", counted({ text: "task.issue" }));

      expect(said(laneless)).toEqual([
        "count-words runs beside others here, and must name its lane",
      ]);
      expect(stagePaths(laneless).filter((path) => path.endsWith("[0].in"))).toHaveLength(1);
    });

    test("and not with it", () => {
      expect(said(inEpic("lane", counted({ text: "task.issue", lane: "task.lane" })))).toEqual([]);
    });
  });

  describe("generate", () => {
    const flow = Result.getOrThrow(Compose.generate(staged, "@chernabog/sdk", STAGE_FILES));

    test("imports the stage, for its input and output", () => {
      expect(flow).toContain('from "../stages/which-pr.ts";');
      expect(flow).toContain('runStage("which-pr", ');
    });

    test("refuses a document whose stage isn't there", () => {
      expect(Result.isFailure(Compose.generate(staged))).toBe(true);
    });

    test("names a stage's step by its round, which isn't its input", () => {
      const looped = Result.getOrThrow(
        Compose.generate(
          inEpic("round", {
            id: "counted",
            stage: "count-words",
            in: { text: "trigger.epic", round: "round" },
            failure: FAILURE,
          }),
          "@chernabog/sdk",
          STAGE_FILES,
        ),
      );

      expect(looped).toContain(
        '{ "text": trigger.epic }, {"Skip":"skip","StepFailed":"person"}, { "round": round })',
      );
    });
  });

  describe("tsc", () => {
    const rejected = (name: string, doc: Doc, says: string) => {
      effect(
        name,
        () =>
          Effect.gen(function* () {
            expect(checked(doc)).toEqual([]);
            expect((yield* compileErrors(doc)).join("\n")).toContain(says);
          }),
        TIMEOUT,
      );
    };

    const counting = (text: string): Step => ({
      id: "counted",
      stage: "count-words",
      in: { text },
      failure: FAILURE,
    });

    effect(
      "compiles a stage wired correctly, in and out",
      () =>
        Effect.gen(function* () {
          expect(yield* compileErrors(staged)).toEqual([]);
          expect(
            yield* compileErrors(
              changingStage(staged, (step) => ({ ...step, with: { note: "from the document" } })),
            ),
          ).toEqual([]);
        }),
      TIMEOUT,
    );

    rejected(
      "a number where a stage takes text",
      leading(staged, counting("trigger.pr")),
      "not assignable to type 'string'",
    );

    rejected(
      "a stage's output where a pull request goes",
      changing(
        leading(staged, {
          id: "counted",
          stage: "count-words",
          with: { text: "a few words" },
          failure: FAILURE,
        }),
        "review",
        (step) => ({ ...step, in: { pr: "counted.words" } }),
      ),
      "PullRequestNumber",
    );

    rejected(
      "an output a stage doesn't have",
      changing(staged, "review", (step) => ({ ...step, in: { pr: "which.number" } })),
      "number",
    );

    rejected(
      "an input a stage doesn't take",
      changingStage(staged, (step) => ({ ...step, with: { title: "x" } })),
      "title",
    );

    rejected(
      "a stage's input left out",
      changingStage(staged, (step) => ({ ...step, in: {} })),
      "pr",
    );
  });

  describe("Compose.describe", () => {
    test("lists the repo's Effect stages, with what each takes and gives", () => {
      const Input = Schema.Struct({ pr: Schema.Finite, note: Schema.optionalKey(Schema.String) });
      const Output = Schema.Struct({ pr: Schema.Finite, labels: Schema.Array(Schema.String) });

      const { stages } = Schema.decodeUnknownSync(
        Schema.Struct({
          stages: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              inputs: Schema.Array(
                Schema.Struct({
                  name: Schema.String,
                  required: Schema.Boolean,
                  under: Schema.String,
                  kind: Schema.String,
                }),
              ),
              gives: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
              failures: Schema.Array(Schema.String),
            }),
          ),
        }),
      )(
        Compose.describe([
          { name: "which-pr", input: Input, output: Output },
          { name: "say", input: Schema.Struct({}), output: Schema.String },
        ]),
      );

      expect(stages).toEqual([
        {
          name: "which-pr",
          inputs: [
            { name: "pr", required: true, under: "in or with", kind: "number" },
            { name: "note", required: false, under: "in or with", kind: "string" },
          ],
          gives: { pr: "number", labels: "Array<string>" },
          failures: ["Skip", "StepFailed"],
        },
        { name: "say", inputs: [], gives: "string", failures: ["Skip", "StepFailed"] },
      ]);
    });

    test("lists none when there are none", () => {
      expect(Compose.describe()).toMatchObject({ stages: [] });
    });

    test("explains stages in the format", () => {
      const { format } = Schema.decodeUnknownSync(Schema.Struct({ format: Schema.String }))(
        Compose.describe(),
      );

      expect(format).toContain("stage: find-work");
      expect(format).toContain("failure: { Skip: skip, StepFailed: person }");
    });
  });
});

describe("the plan document", () => {
  const TIMEOUT = 120_000;
  const plan = documentOf(PLAN_DOCUMENT);

  // The plan document with a line of it changed.
  const planWith = (line: string, replacement: string) => {
    expect(PLAN_DOCUMENT).toContain(line);

    return documentOf(PLAN_DOCUMENT.replace(line, replacement));
  };

  // What the changes branch says, and the same with a step in front of its next.
  const CHANGES = `                - id: asked
                  use: plan.changesAsked
                  in: { issue: trigger.issue, round: round }
`;

  const DONE_DRAFTING = `                - id: early
                  use: plan.doneDrafting
                  in: { issue: trigger.issue }
`;

  test("finds nothing wrong with it", () => {
    expect(Compose.check(plan)).toEqual([]);
  });

  // plan.create, plan.becomeEpic, plan.doneDrafting and plan.askClarification
  // name their steps as the recipe does, with no round, and each runs once,
  // on the way out of the run.
  test("lets a block that runs only on the way out of a run take no round in a repeat", () => {
    expect(
      Object.entries(Blocks.catalogue)
        .filter(([, block]) => Predicate.hasProperty(block, "last") && block.last === true)
        .map(([name]) => name)
        .toSorted(),
    ).toEqual(["plan.askClarification", "plan.becomeEpic", "plan.create", "plan.doneDrafting"]);

    expect(messages(plan)).not.toContain(
      "plan.create names its steps the same in every round, so it can't run in a repeat",
    );
  });

  test("refuses a way past a block that runs on the way out going on to another round", () => {
    const goesOn = planWith(CHANGES, `${CHANGES}${DONE_DRAFTING}`);

    expect(Compose.check(goesOn)).toEqual([
      {
        path: "steps[1].repeat.steps[2].on.changes.steps[2]",
        message:
          "plan.doneDrafting runs only on a run's way out, and this way goes on to another round",
      },
    ]);
  });

  test("refuses one earlier in the round, whatever branch a later next is in", () => {
    const early = planWith(
      "        - id: proposed\n",
      `${DONE_DRAFTING.replaceAll("                ", "        ")}        - id: proposed\n`,
    );

    // It runs again once approved, which is refused on its own.
    expect(Compose.check(early)).toEqual([
      {
        path: "steps[1].repeat.steps[3].on.approved.steps[2].use",
        message: "plan.doneDrafting runs twice on one path, and its step names would collide",
      },
      {
        path: "steps[1].repeat.steps[3].on.changes.steps[1]",
        message:
          "plan.doneDrafting runs only on a run's way out, and this way goes on to another round",
      },
    ]);
  });

  test("still wants a block that runs on the way out to name its lane beside others", () => {
    const epic = documentOf(
      EPIC_DOCUMENT.replace(
        "            - id: gate\n",
        `            - id: early
              use: plan.doneDrafting
              in: { issue: task.issue }
            - id: gate\n`,
      ),
    );

    expect(messages(epic)).toEqual([
      "plan.doneDrafting names its steps the same in every lane, so it can't run beside others",
    ]);
  });

  test("still wants a block that doesn't run only on the way out to take a round", () => {
    const fixed = planWith(
      "in: { issue: trigger.issue, round: round, draft: drafted.draft }",
      "in: { issue: trigger.issue, draft: drafted.draft }\n          with: { round: 1 }",
    );

    expect(Compose.check(fixed)).toEqual([
      {
        path: "steps[1].repeat.steps[1].with.round",
        message: "round comes from an earlier step: put it under in, as step or step.field",
      },
      {
        path: "steps[1].repeat.steps[1].in.round",
        message: "plan.propose runs in every round here, and must take round",
      },
    ]);
  });

  test("refuses the plan source on a flow about anything but a spec", () => {
    expect(Compose.check({ ...plan, subject: "issue" })).toContainEqual({
      path: "trigger[0].use",
      message: "plan.queued finds work on spec, and this is a flow on issue",
    });
  });

  test("refuses a flow on a spec that a person starts", () => {
    expect(Compose.check({ ...plan, trigger: [], start: true })).toContainEqual({
      path: "start",
      message:
        "a person starts only a flow on issue, with chernabog start <issue>, and this is a flow on spec",
    });
  });

  test("says which blocks run only on the way out of a run", () => {
    const { blocks } = Schema.decodeUnknownSync(
      Schema.Struct({
        blocks: Schema.Array(Schema.Struct({ name: Schema.String, last: Schema.Boolean })),
      }),
    )(Compose.describe());

    expect(blocks.filter((block) => block.last).map((block) => block.name)).toContain(
      "plan.create",
    );
    expect(blocks.filter((block) => block.name === "plan.draft")).toEqual([
      { name: "plan.draft", last: false },
    ]);
  });

  test("lists the spec subject, its source and its loop state", () => {
    const listed = Schema.decodeUnknownSync(
      Schema.Struct({
        subjects: Schema.Array(
          Schema.Struct({ name: Schema.String, trigger: Schema.Array(Schema.String) }),
        ),
        loopStates: Schema.Array(Schema.String),
      }),
    )(Compose.describe());

    expect(listed.subjects.filter((subject) => subject.name === "spec")).toEqual([
      { name: "spec", trigger: ["issue", "queued"] },
    ]);
    expect(listed.loopStates).toContain("plan.changes");
  });

  effect(
    "compiles",
    () =>
      Effect.gen(function* () {
        expect(yield* compileErrors(plan)).toEqual([]);
      }),
    TIMEOUT,
  );

  const rejected = (name: string, doc: Doc, says: string) => {
    effect(
      name,
      () =>
        Effect.gen(function* () {
          expect(Compose.check(doc)).toEqual([]);
          expect((yield* compileErrors(doc)).join("\n")).toContain(says);
        }),
      TIMEOUT,
    );
  };

  rejected(
    "refuses, in tsc, issues made from a plan nobody approved",
    planWith("approved: approval.approved", "approved: proposed.plan"),
    "PlanApproved",
  );

  rejected(
    "refuses, in tsc, a plan posted that wasn't drafted and checked",
    planWith("draft: drafted.draft", "draft: state.changes"),
    "Type 'PlanChanges' is not assignable",
  );

  rejected(
    "refuses, in tsc, a next round given something other than a person's changes",
    planWith("next: { changes: asked.changes }", "next: { changes: asked }"),
    "changes",
  );
});
