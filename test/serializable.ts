// What a module's messages and events can't carry over JSON, which the daemon's
// protocol and the dashboard carry them in: each module's serializability test
// runs this over its groups and its events, and expects nothing.

import { Event } from "@effect-server-utils/cqrs";
import {
  checkEventsSerializable,
  checkSerializable,
  type Incompatibility,
} from "@effect-server-utils/cqrs/testing";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

type Group = Parameters<typeof checkSerializable>[0];

// A module's events, keyed here by their tag: tagged structs, or events already
// declared for the bus (Event.make), as the runs' are.
type Events = Readonly<Record<string, { readonly fields: Schema.Struct.Fields } | Event.Any>>;

export const unserializable = (
  groups: ReadonlyArray<Group>,
  events: Events = {},
): Effect.Effect<ReadonlyArray<Incompatibility>> =>
  Effect.gen(function* () {
    const ofGroups = yield* Effect.forEach(groups, checkSerializable);

    const ofEvents = yield* checkEventsSerializable(
      Object.entries(events).map(([tag, schema]) => {
        if (Event.is(schema)) {
          return schema;
        }

        return Event.make(tag, schema.fields);
      }),
    );

    return [...ofGroups.flat(), ...ofEvents];
  });
