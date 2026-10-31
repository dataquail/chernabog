// The unit of work a command declares, for the modules whose stores are files,
// and the pin that keeps each module's commands in their own.
//
// Machine config, paused.json, trust.json and the rest are changed under a lock
// and replaced whole (file-lock.ts), one file at a time, so there is no
// transaction across them to open. Their commands still declare
// `withUnitOfWork`, over a driver that opens nothing, so every command has the
// same boundary: what it dispatches is delivered once it has finished, and a
// dispatch outside one is a defect (docs/adr/0010-commands-declare-their-unit-of-work.md).

import {
  type DeferralSink,
  type Event,
  EventBus,
  type Middleware,
} from "@effect-server-utils/cqrs";
import {
  AfterCommitTransport,
  makeDurableUnitOfWork,
  makeUnitOfWork,
  TransactionDriver,
  type UnitOfWork,
} from "@effect-server-utils/unit-of-work";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

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

// How many reactions a process remembers having run, to drop a repeat.
const REMEMBERED = 4096;

// The id an event carries, which a repeat of it carries too: chernabog's events
// each carry an eventId of their own (run.events.ts). The envelope's id is new
// for every dispatch, so it names a repeat only for an event that carries none.
const eventIdOf = (envelope: Event.Envelope) =>
  Option.getOrElse(
    Option.liftPredicate(envelope.payload, Predicate.hasProperty("eventId")).pipe(
      Option.map((payload) => payload.eventId),
      Option.filter(Predicate.isString),
    ),
    () => envelope.eventId,
  );

// Where a unit of work hands its after-commit reactions: to each subscription,
// once the transaction has committed, in the fiber that committed it and in no
// transaction at all. A reaction to a run reaches GitHub, git or the engine,
// which no transaction may hold state.db's one connection across
// (docs/adr/0010-commands-declare-their-unit-of-work.md); what it writes to
// state.db it writes in a unit of work of its own.
//
// It keeps nothing: a crash between a commit and its reactions loses them, and
// the sweep that retries a failed reaction finds what they left undone
// (docs/adr/0013-event-handlers.md). A reaction to an eventId it has already
// run, successfully, runs no second time.
const ReactionsAfterCommit = Layer.sync(AfterCommitTransport, () => {
  const ran = new Set<string>();

  const remember = (key: string) => {
    ran.add(key);

    for (const oldest of ran) {
      if (ran.size <= REMEMBERED) {
        break;
      }

      ran.delete(oldest);
    }
  };

  // A failure is reported by the bus, and forgotten here, so a repeat of the
  // event tries again.
  const deliverOnce = (bus: EventBus["Service"], envelope: Event.Envelope) => {
    const key = `${eventIdOf(envelope)}\u0000${envelope.handler}`;

    if (ran.has(key)) {
      return Effect.void;
    }

    remember(key);

    return Effect.map(bus.deliver(envelope), (delivered) => {
      if (Exit.isFailure(delivered)) {
        ran.delete(key);
      }
    });
  };

  return AfterCommitTransport.of({
    enqueue: () => Effect.void,
    flush: (envelopes) =>
      Effect.flatMap(Effect.serviceOption(EventBus), (bus) =>
        Effect.forEach(
          Option.toArray(bus).flatMap((found) =>
            envelopes.map((envelope) => [found, envelope] as const),
          ),
          ([found, envelope]) => deliverOnce(found, envelope),
          { discard: true },
        ),
      ),
  });
});

// The unit of work for a store whose transactions hold the one connection
// every other statement waits on: its after-commit reactions run outside any
// transaction (ReactionsAfterCommit), each subscription by its name.
export const UnitOfWorkReactingAfterCommit = makeDurableUnitOfWork().pipe(
  Layer.provide(ReactionsAfterCommit),
);
