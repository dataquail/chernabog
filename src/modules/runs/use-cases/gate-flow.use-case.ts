import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FlowsClient } from "../domain/ports/clients/flows.client.ts";
import { SkipsRepository } from "../domain/ports/repositories/skips.repository.ts";
import { type FlowRef } from "../domain/run/work-item.value-object.ts";
import { SkipRoot } from "../domain/skip/skip.root.ts";
import { Gated } from "./flow.result.ts";

// Asks a flow's own gate whether it may start a run for an item now. It is
// asked before each run a tick starts, since a run started may close it. Why
// it holds the run back, when it does, is recorded as a skip.
export const gateFlowUseCase = Effect.fn("gateFlowUseCase")(function* (
  flow: FlowRef,
  itemKey: string,
) {
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
