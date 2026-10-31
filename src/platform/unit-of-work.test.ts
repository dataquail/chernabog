import { Command } from "@effect-server-utils/cqrs";
import { TransactionDriver, UnitOfWork } from "@effect-server-utils/unit-of-work";
import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { effect } from "../../test/effect-test.ts";
import {
  FileStoresTransactionDriver,
  FileStoresUnitOfWork,
  ownUnitOfWork,
} from "./unit-of-work.ts";

const active = TransactionDriver.use((driver) => driver.isActive);

describe("FileStoresTransactionDriver", () => {
  effect("says a scope is open only inside one, nested ones included", () =>
    Effect.gen(function* () {
      const driver = yield* TransactionDriver;

      expect(yield* active).toBe(false);
      expect(yield* driver.withTransaction(active)).toBe(true);
      expect(
        yield* driver.withTransaction(Effect.andThen(driver.withSavepoint(Effect.void), active)),
      ).toBe(true);
      expect(yield* active).toBe(false);
    }).pipe(Effect.provide(FileStoresTransactionDriver)),
  );

  effect("keeps two fibers' scopes apart", () =>
    Effect.gen(function* () {
      const driver = yield* TransactionDriver;

      const [inside, outside] = yield* Effect.all(
        [driver.withTransaction(Effect.andThen(Effect.yieldNow, active)), active],
        { concurrency: 2 },
      );

      expect([inside, outside]).toEqual([true, false]);
    }).pipe(Effect.provide(FileStoresTransactionDriver)),
  );
});

// Which unit of work each handler ran in.
class Ran extends Context.Service<Ran, Array<UnitOfWork["Service"]>>()("test/Ran") {}

const Which = Command.make("Which", { payload: Schema.Struct({}) });
const group = Command.group(Which);

class WhichCommands extends Context.Service<WhichCommands, Command.Dispatcher<typeof group>>()(
  "test/WhichCommands",
) {}

const handlers = Command.handlersOf(group, {
  Which: () =>
    Effect.gen(function* () {
      (yield* Ran).push(yield* UnitOfWork);
    }),
});

// A dispatcher built beside the file stores' unit of work, dispatched from a
// fiber in another one.
const dispatcher = Layer.effect(
  WhichCommands,
  Effect.flatMap(ownUnitOfWork, (middleware) =>
    Command.dispatcher(group, { middleware: [middleware] }),
  ),
).pipe(Layer.provide(handlers), Layer.provide(FileStoresUnitOfWork));

describe("ownUnitOfWork", () => {
  effect("runs a module's commands in the unit of work its dispatcher was built beside", () =>
    Effect.gen(function* () {
      const caller = yield* UnitOfWork;

      yield* (yield* WhichCommands).Which({});

      const [ran] = yield* Ran;

      expect(ran).toBeDefined();
      expect(ran).not.toBe(caller);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(dispatcher, PassThroughUnitOfWork).pipe(
          Layer.provideMerge(Layer.sync(Ran, () => [])),
        ),
      ),
    ),
  );
});
