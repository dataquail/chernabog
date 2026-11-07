// What a flow document's checks catch: `Compose.check` for what can be said of
// the document itself, `tsc` on its flow file for what its types say, and what
// a block's failure table turns each error into.

import {
  Blocks,
  Compose,
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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  compileErrors,
  documentOf,
  generated,
  IMPLEMENT_DOCUMENT,
  REVIEW_DOCUMENT,
} from "./compose-harness.ts";
import { effect } from "./effect-test.ts";

type Doc = Compose.FlowDocument;

type Step = Compose.Step;

type UseStep = Compose.UseStep;

const implement = documentOf(IMPLEMENT_DOCUMENT);
const review = documentOf(REVIEW_DOCUMENT);

const named = (step: Step, id: string) => !Compose.isEnd(step) && step.id === id;

const withSteps = (doc: Doc, steps: ReadonlyArray<Step>): Doc => ({ ...doc, steps });

// The document with the step changed.
const changing = (doc: Doc, id: string, change: (step: UseStep) => UseStep): Doc =>
  withSteps(
    doc,
    doc.steps.map((step) => {
      if (!Compose.isEnd(step) && step.id === id) {
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
  test("takes the implement and review documents", () => {
    expect(implement.flow).toBe("implement");
    expect(review.subject).toBe("pull-request");
  });

  test("refuses what isn't a document, without throwing", () => {
    for (const nonsense of [1, "flow", [], {}, { subject: "issue", steps: 3 }]) {
      expect(Result.isFailure(Compose.read(nonsense))).toBe(true);
    }
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
      "gate.local takes worktree",
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

  test("names the blocks there are when one isn't", () => {
    const unknown = changing(implement, "gate", (step) => ({ ...step, use: "gate.lint" }));
    expect(messages(unknown)[0]).toContain("no block named gate.lint; there are issue.claim");
  });

  test("knows the sources and subjects there are", () => {
    expect(messages({ ...implement, trigger: [{ use: "cron" }] })[0]).toContain(
      "must be one of issues.queued",
    );

    expect(messages({ ...implement, trigger: [] })).toEqual([
      "must name where the flow's work comes from",
    ]);

    expect(messages({ ...implement, subject: "release" })).toEqual([
      "must be one of issue, pull-request",
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
    "compiles the implement and review documents",
    () =>
      Effect.gen(function* () {
        expect(yield* compileErrors(implement)).toEqual([]);
        expect(yield* compileErrors(review)).toEqual([]);
      }),
    TIMEOUT,
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
