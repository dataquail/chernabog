import { Command } from "@effect-server-utils/cqrs";

import { RunId } from "../../../kernel/run-id.id.ts";
import { NodeRef } from "../domain/plan/node-ref.value-object.ts";
import { NodeDid } from "../domain/run/node-did.value-object.ts";

// A run's flow recording where in its plan the run went (NodeDid). Each is
// recorded once at a node in a round and a lane: a resumed run's workflow
// body, which passes the node again, records nothing new and tells no one. A
// node is left once, and only after it was entered.
export const RecordNodeCommand = Command.make("RecordNodeCommand", {
  payload: { runId: RunId, node: NodeRef, did: NodeDid },
});

export type RecordNodePayload = Command.Payload<typeof RecordNodeCommand>;
