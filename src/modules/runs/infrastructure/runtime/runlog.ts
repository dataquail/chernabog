// Each run's log is a file under ~/.config/chernabog/runs/, one timestamped
// line per entry, tagged with the step it was written in, and the plan node
// when it has one (src/kernel/run-log-line.value-object.ts). `chernabog logs <run>` prints it;
// the TUI tails it.
//
// A spoke's run log is limited to its bound (ADR 23, decision 4): a write that
// would take the file past `RunLogLimit` writes one line saying the log
// stopped instead, and every write after it is dropped, whichever writer of
// the run's log it comes from.

import {
  CurrentActivity,
  CurrentNode,
  type NodeAt,
  printJson,
  RunLog,
  type StepOutcome,
} from "@chernabog/core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunLogLines } from "../../../../kernel/run-log-line.value-object.ts";
import { formatBytes } from "../../../../kernel/spoke-bounds.value-object.ts";
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

// The bytes a run's log may hold; none for no limit, outside a spoke.
export const RunLogLimit = Context.Reference<Option.Option<number>>("chernabog/runs/RunLogLimit", {
  defaultValue: () => Option.none(),
});

// What the line a limited log ends with starts with.
const STOPPED = "chernabog: this run's log stopped at its bound of";

// The tail of a log a stop line is looked for in: more than one line's worth.
const TAIL_BYTES = 1024;

// Whether the log at `path` already ends with its stop line.
const endsStopped = (fs: FileSystem.FileSystem, path: string, size: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(path, { flag: "r" });
      const from = Math.max(0, size - TAIL_BYTES);
      const buffer = new Uint8Array(size - from);
      yield* file.seek(BigInt(from), "start");
      const read = yield* file.read(buffer);

      return new TextDecoder().decode(buffer.subarray(0, read)).includes(STOPPED);
    }),
  );

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
    const limit = yield* RunLogLimit;

    const append = (entry: string) =>
      fs.writeFileString(path, `${entry}\n`, {
        flag: "a",
      });

    // The entry, if the log has room for it under its limit; else the stop
    // line, once.
    const appendWithin = (entry: string, at: string, bytes: number) =>
      Effect.gen(function* () {
        const size = Number(
          Option.match(yield* fs.stat(path).pipe(Effect.option), {
            onNone: () => 0,
            onSome: (info) => info.size,
          }),
        );

        if (size + Buffer.byteLength(entry) + 1 <= bytes) {
          return yield* append(entry);
        }

        if (size > 0 && (yield* endsStopped(fs, path, size))) {
          return;
        }

        // Filled to just past the bound, which is how the hub, measuring the
        // log's size, knows the spoke reached it (ADR 23, decision 4).
        const stop = (filler: number) =>
          RunLogLines.entry(
            at,
            Option.none(),
            `${STOPPED} ${formatBytes(bytes)}; what the run writes after is dropped${" ".repeat(filler)}`,
            Option.none(),
          );

        yield* append(stop(Math.max(0, bytes + 1 - size - Buffer.byteLength(stop(0)) - 1)));
      });

    const write = (step: Option.Option<string>, line: string) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        const node = Option.map(yield* CurrentNode, nodeTagOf);
        const entry = RunLogLines.entry(at, step, line, node);
        yield* fs.makeDirectory(directoryOf(path), { recursive: true });

        yield* Option.match(limit, {
          onNone: () => append(entry),
          onSome: (bytes) => appendWithin(entry, at, bytes),
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
