// An event bus that keeps every event dispatched through it, for a handler
// test to read back in the order they were dispatched.

import { EventBus, makeEventBus } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

// The bus, and what it has dispatched so far.
export const RecordedEvents = Recording.pipe(
  Layer.provideMerge(Layer.sync(DispatchedEvents, () => [])),
  Layer.provide(makeEventBus()),
);
