import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { RunLog } from "../../../modules/runs/queries/read-run-log.query.ts";
import { RunLogsQueries } from "../../../modules/runs/runs.query-handlers.ts";
import { fail, printJson } from "../cli.output.ts";
import { jsonFlag } from "../output.arguments.ts";
import { followRunLog } from "./run-log.output.ts";

export const logsCommand = Command.make(
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
    }).pipe(Effect.catchTag("RunLogMissing", (missing) => fail(missing.message))),
).pipe(Command.withDescription("Print a run's log"));
