// Each run's log is a file under ~/.config/chernabog/runs/, one timestamped
// line per entry, tagged with the step it was written in, and the plan node
// when it has one (src/kernel/run-log-line.value-object.ts). `chernabog logs <run>` prints it;
// the TUI tails it.

import {
  CurrentActivity,
  CurrentNode,
  type NodeAt,
  printJson,
  RunLog,
  type StepOutcome,
} from "@chernabog/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunLogLines } from "../../../../kernel/run-log-line.value-object.ts";
import { NodeRef, NodeRefs } from "../../domain/plan/node-ref.value-object.ts";

export type StepHooks = {
  // A step began, at the plan node it runs in; none in a flow with no plan.
  readonly onStep: (name: string, node: Option.Option<NodeAt>) => Effect.Effect<void>;
  readonly onStepDone: (name: string) => Effect.Effect<void>;
  // A step ended, with how; never for one interrupted or replayed.
  readonly onStepFinished: (name: string, outcome: StepOutcome) => Effect.Effect<void>;
  // A run changed something on GitHub, in a repo by its name, which can tick
  // the repo's flows sooner (#138). `cause` says what, as a tick shows it.
  readonly onChange: (repo: string, cause: string) => Effect.Effect<void>;
};

export const noHooks: StepHooks = {
  onStep: () => Effect.void,
  onStepDone: () => Effect.void,
  onStepFinished: () => Effect.void,
  onChange: () => Effect.void,
};

const directoryOf = (path: string) =>
  Option.getOrElse(
    Option.liftPredicate(path.slice(0, path.lastIndexOf("/")), (dir) => dir.length > 0),
    () => ".",
  );

// A node as its log tag carries it: a JSON object on one line.
const nodeTagOf = (node: NodeAt) =>
  printJson(Schema.encodeSync(Schema.toCodecJson(NodeRef))(NodeRefs.of(node)));

// A log that appends to `path`, creating its directory the first time. Each
// line is tagged with the activity it is written in, which the fiber that
// writes it knows (CurrentActivity), and with the plan node (CurrentNode):
// one an activity forks, such as the one copying a step's output, inherits them.
export const runLogWriting = (path: string, hooks: StepHooks = noHooks) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const write = (step: Option.Option<string>, line: string) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        const node = Option.map(yield* CurrentNode, nodeTagOf);
        yield* fs.makeDirectory(directoryOf(path), { recursive: true });
        yield* fs.writeFileString(path, `${RunLogLines.entry(at, step, line, node)}\n`, {
          flag: "a",
        });
      }).pipe(Effect.orDie);

    const log = (line: string) =>
      Effect.gen(function* () {
        yield* write(yield* CurrentActivity, line);
      });

    return RunLog.of({
      log,
      // A step's own line is its first.
      step: (name) =>
        write(Option.some(name), `step: ${name}`).pipe(
          Effect.andThen(Effect.flatMap(CurrentNode, (node) => hooks.onStep(name, node))),
        ),
      stepDone: hooks.onStepDone,
      stepFinished: hooks.onStepFinished,
    });
  });
