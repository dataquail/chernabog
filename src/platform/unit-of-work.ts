// The unit of work a command declares, for the modules whose stores are files,
// and the pin that keeps each module's commands in their own.
//
// Machine config, paused.json, trust.json and the rest are changed under a lock
// and replaced whole (file-lock.ts), one file at a time, so there is no
// transaction across them to open. Their commands still declare
// `withUnitOfWork`, over a driver that opens nothing, so every command has the
// same boundary: what it dispatches is delivered once it has finished, and a
// dispatch outside one is a defect (docs/adr/0010-commands-declare-their-unit-of-work.md).

import { type DeferralSink, type Middleware } from "@effect-server-utils/cqrs";
import {
  makeUnitOfWork,
  TransactionDriver,
  type UnitOfWork,
} from "@effect-server-utils/unit-of-work";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// How many scopes are open around the running fiber: carried in its context
// rather than shared state, so two commands at once each see only their own.
const OpenScopes = Context.Reference<number>("chernabog/platform/OpenScopes", {
  defaultValue: () => 0,
});

const opened = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.service(OpenScopes), (open) =>
    Effect.provideService(effect, OpenScopes, open + 1),
  );

// A driver that opens nothing: what a file store's change commits is the file
// it replaced, and a failure leaves earlier files as they were written.
export const FileStoresTransactionDriver = Layer.succeed(
  TransactionDriver,
  TransactionDriver.of({
    withTransaction: opened,
    withSavepoint: opened,
    isActive: Effect.map(Effect.service(OpenScopes), (open) => open > 0),
  }),
);

// The unit of work, and the sink after-commit events wait on, for the modules
// whose stores are files.
export const FileStoresUnitOfWork = makeUnitOfWork().pipe(
  Layer.provide(FileStoresTransactionDriver),
);

// A dispatcher's middleware that runs its module's commands in the unit of work
// the dispatcher was built beside. A handler sees the dispatching fiber's
// context, so without it a file store's command dispatched from the daemon,
// which holds state.db, would open a state.db transaction around its files and
// whatever it calls, and every statement in the process would wait on it.
export const ownUnitOfWork = Effect.map(
  Effect.context<UnitOfWork | DeferralSink>(),
  (own): Middleware.Middleware =>
    (dispatch) =>
    (payload) =>
      Effect.provideContext(dispatch(payload), own),
);
