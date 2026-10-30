import { Command } from "@effect-server-utils/cqrs";
import * as Schema from "effect/Schema";

import { RunId } from "../../../kernel/run-id.id.ts";
import { RunLeases } from "../domain/schedule/lease.value-object.ts";

// Reads, or with `renew` renews for that long from now, the lease on each
// claim a run in flight holds (the claim-ref markers it holds), as the run's
// persona. A claim another run took over is Lost, and the run must end; one
// nobody holds any more, such as one the run is about to take, is passed
// over. A read or renewal that fails is CheckFailed, never Lost. Ending a lost
// run is the caller's, through CancelRunCommand.
export const CheckRunLeasesCommand = Command.make("CheckRunLeasesCommand", {
  payload: { runId: RunId, renew: Schema.Option(Schema.Duration) },
  success: RunLeases,
});

export type CheckRunLeasesPayload = Command.Payload<typeof CheckRunLeasesCommand>;
