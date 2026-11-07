// Flow documents as a repo would write them, compiled as a repo would compile
// them: to a flow file on disk, which `tsc` checks and the engine loads.

import { Compose, type Flow } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import ts from "typescript";
import YAML from "yaml";

export const IMPLEMENT_DOCUMENT = `
flow: implement
subject: issue
gate: usage
concurrency: 1
trigger:
  - use: issues.queued
    with: { labels: [eligible, ship] }
failureContext:
  pr: [adopted.number, opened.number]
steps:
  - id: claim
    use: issue.claim
    in: { issue: trigger.issue, queued: trigger.queued }
    with: { adopt: true }
    on:
      adopted:
        as: adopted
        steps:
          - id: ready
            use: pr.awaitReady
            in: { issue: trigger.issue, adopted: adopted }
            with: { within: 14 days }
          - id: adoptedCi
            use: ci.waitPreparing
            in: { pr: adopted.number, branch: claim.branch, base: claim.base }
          - id: handedOver
            use: issue.handOffAdopted
            in: { issue: trigger.issue, adopted: adopted, branch: claim.branch }
          - end: done
            summary: handedOver
  - id: worktree
    use: worktree.prepare
    in: { branch: claim.branch, base: claim.base }
  - id: agent
    use: agent.implement
    in: { issue: trigger.issue, worktree: worktree, base: claim.base }
    on:
      needs-clarification:
        as: questions
        steps:
          - id: asked
            use: issue.askClarification
            in: { issue: trigger.issue, outcome: questions, queued: trigger.queued }
          - end: needs-human
            reason: asked
  - id: gate
    use: gate.local
    in: { worktree: worktree }
  - id: push
    use: branch.push
    in: { worktree: worktree, branch: claim.branch, base: claim.base, committed: agent.committed }
  - id: opened
    use: pr.open
    in:
      issue: trigger.issue
      outcome: agent.outcome
      queued: trigger.queued
      base: claim.base
      pushed: push.pushed
  - id: ci
    use: ci.waitAndFix
    in: { pr: opened.number, worktree: worktree, branch: claim.branch, base: claim.base }
  - id: done
    use: issue.handOff
    in: { issue: trigger.issue, pr: opened, outcome: agent.outcome }
  - end: done
    summary: done
`;

export const REVIEW_DOCUMENT = `
flow: review
subject: pull-request
concurrency: 1
trigger:
  - use: review.requested
  - use: review.waitingElsewhere
steps:
  - id: review
    use: review.round
    in: { pr: trigger.pr }
    with: { round: 1, role: reviewer }
    on:
      approve:
        as: verdict
        steps:
          - id: land
            use: pr.land
            in: { pr: trigger.pr, approved: verdict.approved }
            with: { method: squash }
          - end: done
            summary: land
      changes:
        steps:
          - end: done
            summary: review.changesAsked
`;

export const RE_REVIEW_DOCUMENT = `
flow: re-review
subject: pull-request
concurrency: 1
trigger:
  - use: review.requestedAgain
steps:
  - id: earlier
    use: review.latestOwn
    in: { pr: trigger.pr }
    on:
      none:
        steps:
          - id: review
            use: review.round
            in: { pr: trigger.pr }
            with: { round: 1, role: reviewer }
            on:
              approve:
                as: verdict
                steps:
                  - id: land
                    use: pr.land
                    in: { pr: trigger.pr, approved: verdict.approved }
                    with: { method: squash }
                  - end: done
                    summary: land
              changes:
                steps:
                  - end: done
                    summary: review.changesAsked
      found:
        as: own
        steps:
          - id: rounds
            use: review.roundsLeft
            in: { review: own }
            on:
              exhausted:
                as: why
                steps:
                  - id: capped
                    use: pr.handToPerson
                    in: { pr: trigger.pr, reason: why }
                  - end: needs-human
                    reason: capped
          - id: recheck
            use: review.recheck
            in: { pr: trigger.pr, review: own }
            on:
              approve:
                as: approval
                steps:
                  - id: landed
                    use: pr.land
                    in: { pr: trigger.pr, approved: approval.approved }
                    with: { method: squash }
                  - end: done
                    summary: landed
              changes:
                as: open
                steps:
                  - id: handed
                    use: pr.handToPerson
                    in: { pr: trigger.pr, reason: open.reason }
                  - end: needs-human
                    reason: handed
`;

export const ADDRESS_REVIEW_DOCUMENT = `
flow: address-review
subject: changes-asked
gate: usage
concurrency: 1
trigger:
  - use: review.changesRequested
steps:
  - id: asked
    use: review.changesAsked
    in: { pr: trigger.pr, reviewer: trigger.reviewer, reviewedSha: trigger.reviewedSha }
  - id: author
    use: author.session
    in: { pr: trigger.pr }
  - id: worktree
    use: author.worktree
    in: { branch: trigger.branch }
  - id: considered
    use: author.consider
    in: { pr: trigger.pr, review: asked, session: author }
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
  - id: addressed
    use: author.address
    in: { pr: trigger.pr, review: asked, session: author }
    on:
      needs-clarification:
        as: questions
        steps:
          - id: asking
            use: pr.handToPerson
            in: { pr: trigger.pr, reason: questions.reason }
          - end: needs-human
            reason: asking
  - id: changed
    use: author.checkChanged
    in: { pr: trigger.pr, review: asked, reviewedSha: trigger.reviewedSha, worktree: worktree }
  - id: gate
    use: author.localGate
    in: { pr: trigger.pr, review: asked, worktree: worktree, session: author }
  - id: pushed
    use: author.push
    in:
      worktree: worktree
      branch: trigger.branch
      base: trigger.base
      review: asked
      session: author
      committed: addressed.committed
  - id: ci
    use: author.waitForCi
    in:
      pr: trigger.pr
      worktree: worktree
      branch: trigger.branch
      base: trigger.base
      review: asked
      session: author
  - id: again
    use: review.askAgain
    in:
      pr: trigger.pr
      review: asked
      reviewer: trigger.reviewer
      summary: addressed.summary
      pushed: pushed.pushed
  - end: done
    summary: again
`;

export const RESOLVE_CONFLICTS_DOCUMENT = `
flow: resolve-conflicts
subject: conflict
gate: usage
concurrency: 1
trigger:
  - use: pr.conflicting
steps:
  - id: worktree
    use: author.worktree
    in: { branch: trigger.branch }
  - id: resolved
    use: conflict.resolve
    in: { pr: trigger.pr, branch: trigger.branch, base: trigger.base, worktree: worktree }
    on:
      needs-human:
        as: stuck
        steps:
          - id: handed
            use: pr.handToPerson
            in: { pr: trigger.pr, reason: stuck.reason }
          - end: needs-human
            reason: handed
  - id: gate
    use: conflict.localGate
    in: { pr: trigger.pr, worktree: worktree, session: resolved.session }
  - id: pushed
    use: conflict.push
    in:
      worktree: worktree
      branch: trigger.branch
      base: trigger.base
      committed: resolved.committed
  - id: said
    use: conflict.report
    in: { pr: trigger.pr, base: trigger.base, summary: resolved.summary, pushed: pushed.pushed }
  - id: ci
    use: conflict.waitForCi
    in:
      pr: trigger.pr
      worktree: worktree
      branch: trigger.branch
      base: trigger.base
      session: resolved.session
  - id: again
    use: conflict.askApproverAgain
    in: { pr: trigger.pr, base: trigger.base, pushed: pushed.pushed }
  - end: done
    summary: again
`;

export const POST_MERGE_DOCUMENT = `
flow: post-merge
subject: merged
concurrency: 4
trigger:
  - use: pr.mergedRecently
steps:
  - id: watching
    use: merged.markWatched
    in: { pr: trigger.pr, sha: trigger.sha, base: trigger.base }
  - id: ci
    use: merged.awaitCi
    in: { pr: trigger.pr, sha: trigger.sha, base: trigger.base }
    on:
      none:
        as: quiet
        steps:
          - end: done
            summary: quiet.summary
      green:
        as: passed
        steps:
          - end: done
            summary: passed.summary
      red:
        as: red
        steps:
          - id: before
            use: merged.redBefore
            in: { pr: trigger.pr, sha: trigger.sha }
            on:
              already-red:
                as: already
                steps:
                  - end: done
                    summary: already.summary
          - id: fixed
            use: merged.closesFollowUp
            in: { issue: trigger.issue }
          - id: details
            use: merged.failureDetails
            in: { ci: red }
          - id: filed
            use: merged.fileFollowUp
            in:
              pr: trigger.pr
              url: trigger.url
              title: trigger.title
              sha: trigger.sha
              base: trigger.base
              ci: red
              details: details
              fixed: fixed
          - id: linked
            use: merged.linkFollowUp
            in:
              pr: trigger.pr
              sha: trigger.sha
              base: trigger.base
              followUp: filed
              fixed: fixed
          - end: done
            summary: linked
`;

export const EPIC_DOCUMENT = `
flow: epic
subject: epic
gate: usage
concurrency: 1
trigger:
  - use: epic.queued
steps:
  - id: claimed
    use: epic.claim
    in: { epic: trigger.epic }
  - id: ships
    use: epic.ships
  - id: howMany
    use: epic.atOnce
  - id: rounds
    repeat:
      state: { tasks: epic.tasks, stack: stack.upkeep }
      steps:
        - id: progress
          use: epic.progress
          in: { epic: trigger.epic, round: round }
        - id: status
          use: epic.postStatus
          in: { epic: trigger.epic, round: round, progress: progress }
        - id: noted
          use: epic.noteWaits
          in: { progress: progress, tasks: state.tasks }
        - id: closed
          use: epic.finished
          in: { epic: trigger.epic, progress: progress }
          on:
            finished:
              as: summary
              steps:
                - end: done
                  summary: summary
        - id: carried
          use: stack.carryUp
          in: { round: round, progress: progress, stack: state.stack }
          on:
            moved:
              as: moved
              steps:
                - next: { tasks: noted.tasks, stack: moved }
        - id: landed
          use: stack.land
          if: ships.value
          in: { round: round, progress: progress, stack: carried.stack }
          on:
            moved:
              as: moved
              steps:
                - next: { tasks: noted.tasks, stack: moved }
        - id: latest
          first: [landed, carried]
        - id: ready
          use: epic.startable
          in: { progress: progress, tasks: noted.tasks }
          on:
            none:
              as: waiting
              steps:
                - id: parked
                  use: epic.park
                  in: { round: round }
                  with: { lookAgainAfter: 1 day }
                - next: { tasks: waiting, stack: latest.stack }
        - id: started
          forEach: ready.starts
          as: task
          scope: epic.task
          atOnce: howMany.value
          failureContext:
            pr: [published.pr.number]
          steps:
            - id: claim
              use: issue.claim
              in: { issue: task.issue, base: task.base, lane: task.lane }
            - id: worktree
              use: worktree.prepare
              in: { branch: claim.branch, base: claim.base, lane: task.lane }
            - id: agent
              use: agent.implement
              in: { issue: task.issue, worktree: worktree, base: claim.base, lane: task.lane }
              on:
                needs-clarification:
                  as: questions
                  steps:
                    - id: asked
                      use: issue.askClarification
                      in: { issue: task.issue, outcome: questions, lane: task.lane }
                    - id: released
                      use: issue.releaseClaim
                      in: { issue: task.issue, lane: task.lane }
                    - end: done
            - id: gate
              use: gate.local
              in: { worktree: worktree, lane: task.lane }
            - id: published
              use: stack.publish
              in:
                issue: task.issue
                epic: trigger.epic
                worktree: worktree
                branch: claim.branch
                base: claim.base
                outcome: agent.outcome
                ship: ships.value
                lane: task.lane
                committed: agent.committed
            - id: ci
              use: ci.waitAndFix
              in:
                pr: published.pr.number
                worktree: worktree
                branch: claim.branch
                base: published.base
                lane: task.lane
            - id: done
              use: issue.handOff
              in: { issue: task.issue, pr: published.pr, outcome: agent.outcome, lane: task.lane }
        - id: recorded
          use: epic.recordEndings
          in: { tasks: ready.started, endings: started }
        - next: { tasks: recorded.tasks, stack: latest.stack }
`;

// A repo's own steps, in .chernabog/stages/ by file name: two Effect stages,
// typed, and a shell stage, which isn't.
export const STAGES = {
  "which-pr.ts": `import { defineStage } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Output = Schema.Struct({ pr: Schema.Number.pipe(Schema.brand("PullRequestNumber")) });

export default defineStage({
  name: "which-pr",
  input: Schema.Struct({ pr: Schema.Number, note: Schema.optionalKey(Schema.String) }),
  output: Output,
  run: (input) => Effect.succeed(Schema.decodeSync(Output)({ pr: input.pr })),
});
`,
  "count-words.ts": `import { defineStage } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export default defineStage({
  name: "count-words",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ words: Schema.Number, long: Schema.Boolean }),
  run: (input) => {
    const words = input.text.split(" ").length;

    return Effect.succeed({ words, long: words > 100 });
  },
});
`,
  notify: "#!/bin/sh\necho '{}'\n",
};

export const STAGE_FILES = Object.keys(STAGES);

// The review document with a stage of the repo's own in front, which names the
// pull request the review and the merge then take.
export const REVIEW_WITH_STAGE_DOCUMENT = `
flow: review
subject: pull-request
concurrency: 1
trigger:
  - use: review.requested
  - use: review.waitingElsewhere
steps:
  - id: which
    stage: which-pr
    in: { pr: trigger.pr }
    failure: { Skip: skip, StepFailed: fail }
  - id: review
    use: review.round
    in: { pr: which.pr }
    with: { round: 1, role: reviewer }
    on:
      approve:
        as: verdict
        steps:
          - id: land
            use: pr.land
            in: { pr: which.pr, approved: verdict.approved }
            with: { method: squash }
          - end: done
            summary: land
      changes:
        steps:
          - end: done
            summary: review.changesAsked
`;

export const documentOf = (source: string) =>
  Result.getOrThrow(Compose.read(Schema.decodeUnknownSync(Schema.Json)(YAML.parse(source))));

// A generated flow's file, under node_modules, so it resolves the SDK and effect
// as a repo's does and nothing that checks the source tree sees it, in flows/
// beside the stages, as a repo's .chernabog/ has them. It goes when the
// test's scope does.
const writeFlow = (source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cache = yield* path.fromFileUrl(new URL("../node_modules/.cache", import.meta.url));
    yield* fs.makeDirectory(cache, { recursive: true });
    const directory = yield* fs.makeTempDirectoryScoped({ directory: cache, prefix: "compose-" });
    yield* fs.makeDirectory(path.join(directory, "flows"));
    yield* fs.makeDirectory(path.join(directory, "stages"));
    const file = path.join(directory, "flows", "flow.ts");
    yield* fs.writeFileString(file, source);

    for (const [name, stage] of Object.entries(STAGES)) {
      yield* fs.writeFileString(path.join(directory, "stages", name), stage);
    }

    return file;
  });

export const generated = (document: Compose.FlowDocument) =>
  Result.getOrThrow(Compose.generate(document, "@chernabog/sdk", STAGE_FILES));

// A flow file's source as the engine would load it.
export const loadSource = (source: string) =>
  Effect.gen(function* () {
    const file = yield* writeFlow(source);

    const module = yield* Effect.promise((): Promise<{ readonly default: Flow }> => import(file));

    return module.default;
  });

// A document as the engine would load it.
export const loadFlow = (document: Compose.FlowDocument) => loadSource(generated(document));

const options = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));

  return ts.parseJsonConfigFileContent(
    ts.readConfigFile(path.join(root, "tsconfig.json"), (file) => ts.sys.readFile(file)).config,
    ts.sys,
    root,
  ).options;
});

let previous = Option.none<ts.Program>();

// What `tsc` says of the document's flow file: nothing when it compiles.
export const compileErrors = (document: Compose.FlowDocument) =>
  Effect.gen(function* () {
    const file = yield* writeFlow(generated(document));
    const compilerOptions = yield* options;

    const program = ts.createProgram(
      [file],
      { ...compilerOptions, noEmit: true },
      void 0,
      Option.getOrUndefined(previous),
    );

    previous = Option.some(program);

    return ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName === file)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
  });
