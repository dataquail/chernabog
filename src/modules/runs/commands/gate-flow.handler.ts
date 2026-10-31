import { withUnitOfWork } from "@effect-server-utils/unit-of-work";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { SkipRoot } from "../domain/skip/skip.root.ts";
import { Gated } from "../domain/skip/skip-view.value-object.ts";
import { SkipsRepository } from "../domain/skip/skips.repository.ts";
import { type GateFlowPayload } from "./gate-flow.command.ts";

// The unit of work around this command's reads and writes in state.db alone.
// What it asks of GitHub, git, a launcher or the engine stays outside it: a
// transaction holds state.db's one connection, which the engine's journal
// waits on (docs/adr/0009-commands-declare-their-unit-of-work.md).
const inUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    withUnitOfWork,
    // state.db is a file on this machine: it has no outage to wait out.
    Effect.catchTag("PersistenceUnavailable", Effect.die),
  );

export const gateFlowHandler = Effect.fn("gateFlowHandler")(function* ({
  flow,
  itemKey,
}: GateFlowPayload) {
  const held = yield* (yield* FlowsClient).gate(flow);

  for (const reason of Option.toArray(held)) {
    const skip = SkipRoot.make({
      repo: flow.repo,
      persona: flow.persona,
      flow: flow.flow,
      itemKey: Option.some(itemKey),
      reason,
      at: DateTime.formatIso(yield* DateTime.now),
    });

    yield* SkipsRepository.use((skips) => skips.insertOne(skip)).pipe(inUnitOfWork);
  }

  return Gated.make({ held });
});
