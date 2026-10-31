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

// A module's events are tagged structs, keyed here by their tag.
type Events = Readonly<Record<string, { readonly fields: Schema.Struct.Fields }>>;

export const unserializable = (
  groups: ReadonlyArray<Group>,
  events: Events = {},
): Effect.Effect<ReadonlyArray<Incompatibility>> =>
  Effect.gen(function* () {
    const ofGroups = yield* Effect.forEach(groups, checkSerializable);

    const ofEvents = yield* checkEventsSerializable(
      Object.entries(events).map(([tag, schema]) => Event.make(tag, schema.fields)),
    );

    return [...ofGroups.flat(), ...ofEvents];
  });
