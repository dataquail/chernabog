import * as Effect from "effect/Effect";

import { WorkflowsClient } from "../domain/ports/clients/workflows.client.ts";
import { type ReadSpokeReportsPayload, SpokeReportsRead } from "./read-spoke-reports.query.ts";

export const readSpokeReportsHandler = Effect.fn("readSpokeReportsHandler")(function* ({
  after,
  runId,
}: ReadSpokeReportsPayload) {
  return SpokeReportsRead.make({
    reports: yield* (yield* WorkflowsClient).reports(runId, after),
  });
});
