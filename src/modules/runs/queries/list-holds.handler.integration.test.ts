import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../test/sqlite.ts";
import { HoldsRoot } from "../domain/holds/holds.root.ts";
import { HoldsRepository } from "../domain/ports/repositories/holds.repository.ts";
import { HoldsRepositoryLive } from "../infrastructure/repositories/holds.repository-live.ts";
import { listHoldsHandler } from "./list-holds.handler.ts";

const holds = (flow: string, items: ReadonlyArray<{ itemKey: string; reason: string }>) =>
  HoldsRoot.make({
    repo: "demo",
    persona: Option.some("bob"),
    flow,
    items,
    at: "2026-10-20T00:00:00.000Z",
  });

describe("listHoldsHandler", () => {
  effect("lists each held item of every flow, with why", () =>
    Effect.gen(function* () {
      const repository = yield* HoldsRepository;
      yield* repository.save(
        holds("implement", [
          { itemKey: "issue-14", reason: "waits on #12, #13" },
          { itemKey: "issue-16", reason: "waits on #15" },
        ]),
      );
      yield* repository.save(holds("review", []));

      const { holds: listed } = yield* listHoldsHandler();

      expect(listed.map((hold) => `${hold.flow} ${hold.itemKey}: ${hold.reason}`)).toEqual([
        "implement issue-14: waits on #12, #13",
        "implement issue-16: waits on #15",
      ]);
      expect(listed[0]?.persona).toEqual(Option.some("bob"));
    }).pipe(Effect.provide(HoldsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
