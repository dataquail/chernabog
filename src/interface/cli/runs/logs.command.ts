import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { readRunLogUseCase } from "../../../modules/runs/use-cases/read-run-log.use-case.ts";
import { resolveRunIdUseCase } from "../../../modules/runs/use-cases/resolve-run-id.use-case.ts";
import { RunLog } from "../../../modules/runs/use-cases/run-log.result.ts";
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
      const { runId } = yield* resolveRunIdUseCase(run);
      const log = yield* readRunLogUseCase(runId);

      if (follow) {
        return yield* followRunLog(runId).pipe(Effect.asVoid);
      }

      if (json) {
        return yield* printJson(RunLog, log);
      }

      yield* Console.log(log.text.trimEnd());
    }).pipe(Effect.catchTag("RunLogMissing", (missing) => fail(missing.message))),
).pipe(Command.withDescription("Print a run's log"));
