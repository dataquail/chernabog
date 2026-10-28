import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effect } from "../../../../../test/effect-test.ts";
import { sqliteAfter } from "../../../../../test/sqlite.ts";
import { HoldsRoot } from "../../domain/holds/holds.root.ts";
import { HoldsRepository } from "../../domain/ports/repositories/holds.repository.ts";
import { HoldsRepositoryLive } from "./holds.repository-live.ts";

const holds = (persona: Option.Option<string>, ...keys: ReadonlyArray<string>) =>
  HoldsRoot.make({
    repo: "demo",
    persona,
    flow: "implement",
    items: keys.map((itemKey) => ({ itemKey, reason: `${itemKey} waits` })),
    at: "2026-10-20T00:00:00Z",
  });

const bob = Option.some("bob");

describe("HoldsRepositoryLive", () => {
  effect("replaces one flow's holds, as one persona or the implicit one, and no other's", () =>
    Effect.gen(function* () {
      const repository = yield* HoldsRepository;
      yield* repository.save(holds(bob, "issue-1"));
      yield* repository.save(holds(Option.none(), "issue-3"));
      yield* repository.save(holds(bob, "issue-7", "issue-5"));

      expect(yield* repository.findAll).toEqual([
        holds(Option.none(), "issue-3"),
        holds(bob, "issue-7", "issue-5"),
      ]);

      yield* repository.save(holds(Option.none()));

      expect(yield* repository.findAll).toEqual([holds(bob, "issue-7", "issue-5")]);
    }).pipe(Effect.provide(HoldsRepositoryLive.pipe(Layer.provide(sqliteAfter(Effect.void))))),
  );
});
