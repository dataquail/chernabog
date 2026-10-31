import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { FlowsClientFake } from "../infrastructure/clients/flows.client-fake.ts";
import { SkipsRepositoryFake } from "../infrastructure/repositories/skips.repository-fake.ts";
import { listRecentSkipsHandler } from "../queries/list-recent-skips.handler.ts";
import { gateFlowHandler } from "./gate-flow.handler.ts";

const review = { repo: "demo", flow: "review", persona: Option.some("bob") };

describe("gateFlowHandler", () => {
  effect("holds a run back when the flow's gate is closed, and records why", () =>
    Effect.gen(function* () {
      const open = yield* gateFlowHandler({ flow: review, itemKey: "pr-1" });

      const closed = yield* gateFlowHandler({
        flow: { ...review, flow: "gated" },
        itemKey: "pr-2",
      });

      const { skips } = yield* listRecentSkipsHandler({ latest: 5 });

      expect(open.held).toEqual(Option.none());
      expect(closed.held).toEqual(Option.some("usage gate: over the ceiling"));
      expect(skips.map((skip) => [skip.flow, skip.itemKey, skip.reason])).toEqual([
        ["gated", Option.some("pr-2"), "usage gate: over the ceiling"],
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SkipsRepositoryFake([]),
          FlowsClientFake({
            "demo/review": { items: [] },
            "demo/gated": { items: [], gate: "usage gate: over the ceiling" },
          }),
        ),
      ),
    ),
  );
});
