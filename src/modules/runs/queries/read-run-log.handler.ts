import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RunLogLines } from "../../../kernel/run-log-line.value-object.ts";
import { NodeRef, NodeRefs } from "../domain/plan/node-ref.value-object.ts";
import { RunLogsClient } from "../domain/ports/clients/run-logs.client.ts";
import { RunLogMissing, RunLogPruned } from "../domain/run/run.errors.ts";
import { RUN_LOG_RETENTION_DAYS } from "../domain/run/run-log-retention.value-object.ts";
import { type LoggedAt, type ReadRunLogPayload, RunLog } from "./read-run-log.query.ts";

const NodeTag = Schema.fromJsonString(NodeRef);

// A step at a node, as one line: the step, a tab, and the node's key.
const placeOf = (step: string, node: Option.Option<NodeRef>) =>
  `${step}\t${Option.match(node, { onNone: () => "", onSome: NodeRefs.keyOf })}`;

// `text` as a person reads it: the whole of it, or only the lines the steps
// in `only` wrote at their nodes.
const shown = (text: string, only: Option.Option<ReadonlyArray<LoggedAt>>) =>
  Option.match(only, {
    onNone: () => RunLogLines.untagged(text),
    onSome: (steps) => {
      const wanted = new Set(
        steps.map((step) => placeOf(step.step, Option.fromUndefinedOr(step.node))),
      );

      return RunLogLines.linesWhere(text, (step, node) =>
        wanted.has(placeOf(step, Option.flatMap(node, Schema.decodeUnknownOption(NodeTag)))),
      );
    },
  });

export const readRunLogHandler = Effect.fn("readRunLogHandler")(function* ({
  only,
  runId,
}: ReadRunLogPayload) {
  const logs = yield* RunLogsClient;
  const path = yield* logs.pathOf(runId);
  const text = yield* logs.readFrom(runId, 0);

  if (Option.isSome(text)) {
    return RunLog.make({ runId, path, text: shown(text.value, Option.fromUndefinedOr(only)) });
  }

  if (yield* logs.pruned(runId)) {
    return yield* new RunLogPruned({ runId, days: RUN_LOG_RETENTION_DAYS });
  }

  return yield* new RunLogMissing({ runId, path });
});
