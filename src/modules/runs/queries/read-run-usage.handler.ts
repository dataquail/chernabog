import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type ReadRunUsagePayload, RunUsage } from "./read-run-usage.query.ts";

export const readRunUsageHandler = Effect.fn("readRunUsageHandler")(function* (
  _: ReadRunUsagePayload,
) {
  return yield* Effect.succeed(RunUsage.make({ tokens: Option.none(), computeMs: Option.none() }));
});
