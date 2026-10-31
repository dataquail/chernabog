// An event bus that keeps every event dispatched through it, for a handler
// test to read back in the order they were dispatched, with the unit of work
// the handler dispatches in.

import { EventBus, makeEventBus } from "@effect-server-utils/cqrs";
import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// A bare event bus, for a test outside test/ that builds its own runtime: only
// the shared runtime and test/ may call a bus factory (ADR 15).
export const TestEventBus = makeEventBus();

export class DispatchedEvents extends Context.Service<
  DispatchedEvents,
  // Every domain event a module's commands dispatch carries its eventId.
  Array<{ readonly _tag: string; readonly eventId?: string }>
>()("test/DispatchedEvents") {}

const Recording = Layer.effect(
  EventBus,
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const dispatched = yield* DispatchedEvents;

    return EventBus.of({
      ...bus,
      dispatch: (events) =>
        Effect.sync(() => {
          for (const event of events) {
            dispatched.push(event);
          }
        }).pipe(Effect.andThen(bus.dispatch(events))),
    });
  }),
);

// The bus, what it has dispatched so far, and the unit of work a command
// declares: the library's own over a driver that opens nothing, which still
// fails a dispatch outside one (EventDispatchedOutsideUnitOfWork).
export const RecordedEvents = Layer.mergeAll(
  Recording.pipe(
    Layer.provideMerge(Layer.sync(DispatchedEvents, () => [])),
    Layer.provide(makeEventBus()),
  ),
  PassThroughUnitOfWork,
);
