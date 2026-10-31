import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { fail, printJson } from "../../../../interface/cli/cli.output.ts";
import { jsonFlag } from "../../../../interface/cli/output.arguments.ts";
import { RunLog } from "../../queries/read-run-log.query.ts";
import { RunLogsQueries } from "../../runs.query-handlers.ts";
import { followRunLog } from "./run-log.output.ts";

export const logsEndpoint = Command.make(
  "logs",
  {
    run: Argument.String("run"),
    follow: Flag.Boolean("follow").pipe(Flag.withAlias("f"), Flag.withDefault(false)),
    json: jsonFlag,
  },
  ({ follow, json, run }) =>
    Effect.gen(function* () {
      const logs = yield* RunLogsQueries;
      const { runId } = yield* logs.ResolveRunIdQuery({ asked: run });
      const log = yield* logs.ReadRunLogQuery({ runId });

      if (follow) {
        return yield* followRunLog(runId).pipe(Effect.asVoid);
      }

      if (json) {
        return yield* printJson(RunLog, log);
      }

      yield* Console.log(log.text.trimEnd());
    }).pipe(
      // A log pruned past its retention is how its run is now, not an error.
      Effect.catchTags({
        RunLogPruned: (pruned) => Console.log(pruned.message),
        RunLogMissing: (missing) => fail(missing.message),
      }),
    ),
).pipe(Command.withDescription("Print a run's log"));
