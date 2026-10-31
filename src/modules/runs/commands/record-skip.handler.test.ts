import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { SkipsRepositoryFake } from "../infrastructure/repositories/skips.repository-fake.ts";
import { listRecentSkipsHandler } from "../queries/list-recent-skips.handler.ts";
import { recordSkipHandler } from "./record-skip.handler.ts";

describe("recordSkipHandler", () => {
  effect("records why the tick skipped, and when", () =>
    Effect.gen(function* () {
      const recorded = yield* recordSkipHandler({
        repo: "demo",
        persona: Option.some("bob"),
        flow: "review",
        itemKey: Option.none(),
        reason: "paused",
      });

      expect(recorded.at.length > 0).toBe(true);
      expect((yield* listRecentSkipsHandler({ latest: 5 })).skips).toEqual([recorded]);
    }).pipe(Effect.provide([SkipsRepositoryFake([]), PassThroughUnitOfWork])),
  );
});
