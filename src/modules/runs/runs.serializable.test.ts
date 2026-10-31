import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";

import { effect } from "../../../test/effect-test.ts";
import { unserializable } from "../../../test/serializable.ts";
import {
  PullRequestOpened,
  RunEnteredStep,
  RunFinished,
  RunNeedsAttention,
  RunStarted,
} from "./domain/run/run.events.ts";
import { runFlowsCommandGroup, runsCommandGroup } from "./runs.command-handlers.ts";
import {
  notificationsQueryGroup,
  runFlowsQueryGroup,
  runLogsQueryGroup,
  runsQueryGroup,
} from "./runs.query-handlers.ts";

// The daemon's protocol and the dashboard carry the runs module's messages and events
// over JSON, so each must survive a round trip through it (ADR 15).
describe("the runs module's messages and events", () => {
  effect("all cross JSON", () =>
    Effect.gen(function* () {
      expect(
        yield* unserializable(
          [
            runFlowsCommandGroup,
            runsCommandGroup,
            notificationsQueryGroup,
            runFlowsQueryGroup,
            runLogsQueryGroup,
            runsQueryGroup,
          ],
          { PullRequestOpened, RunEnteredStep, RunFinished, RunNeedsAttention, RunStarted },
        ),
      ).toEqual([]);
    }),
  );
});
