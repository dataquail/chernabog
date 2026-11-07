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
          in: { tasks: ready.tasks, endings: started }
        - next: { tasks: recorded.tasks, stack: latest.stack }
`;

export const documentOf = (source: string) =>
  Result.getOrThrow(Compose.read(Schema.decodeUnknownSync(Schema.Json)(YAML.parse(source))));

// A generated flow's file, under node_modules, so it resolves the SDK and effect
// as a repo's does and nothing that checks the source tree sees it. It goes
// when the test's scope does.
const writeFlow = (source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cache = yield* path.fromFileUrl(new URL("../node_modules/.cache", import.meta.url));
    yield* fs.makeDirectory(cache, { recursive: true });
    const directory = yield* fs.makeTempDirectoryScoped({ directory: cache, prefix: "compose-" });
    const file = path.join(directory, "flow.ts");
    yield* fs.writeFileString(file, source);

    return file;
  });

export const generated = (document: Compose.FlowDocument) =>
  Result.getOrThrow(Compose.generate(document));

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
