import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { SkipsRepository } from "../domain/ports/repositories/skips.repository.ts";
import { SkipRoot } from "../domain/skip/skip.root.ts";
import { Gated } from "../domain/skip/skip-view.value-object.ts";
import { type GateFlowPayload } from "./gate-flow.command.ts";

export const gateFlowHandler = Effect.fn("gateFlowHandler")(function* ({
  flow,
  itemKey,
}: GateFlowPayload) {
  const held = yield* (yield* FlowsClient).gate(flow);

  for (const reason of Option.toArray(held)) {
    yield* (yield* SkipsRepository).save(
      SkipRoot.make({
        repo: flow.repo,
        persona: flow.persona,
        flow: flow.flow,
        itemKey: Option.some(itemKey),
        reason,
        at: DateTime.formatIso(yield* DateTime.now),
      }),
    );
  }

  return Gated.make({ held });
});
