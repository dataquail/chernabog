import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as Effect from "effect/Effect";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { type ReportRunEndedPayload } from "./report-run-ended.command.ts";

// Writes only the run's journal, which is no part of a state.db transaction:
// its unit of work opens nothing there
// (docs/adr/0010-commands-declare-their-unit-of-work.md).
export const reportRunEndedHandler = Effect.fn("reportRunEndedHandler")(
  function* ({ ending, runId }: ReportRunEndedPayload) {
    yield* (yield* WorkflowsClient).reportEnded(runId, ending);
  },
  withUnitOfWork,
  // state.db is a file on this machine: it has no outage to wait out.
  Effect.catchTag("PersistenceUnavailable", Effect.die),
);
