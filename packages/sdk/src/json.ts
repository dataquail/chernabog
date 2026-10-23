// JSON at the edges: every parse and print goes through a Schema codec, so a
// value is checked the moment it crosses the boundary.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type Json = Schema.Json;

const JsonText = Schema.fromJsonString(Schema.Json);

// Text another program wrote, read as JSON; none when it isn't JSON.
export const parseJson = (text: string): Option.Option<Json> => Schema.decodeOption(JsonText)(text);

export const printJson = (value: Json): string => Schema.encodeSync(JsonText)(value);

// Each line of a JSON Lines file that the schema accepts; the others are skipped.
export const decodeJsonLines = <A>(
  schema: Schema.Codec<A, string>,
  text: string,
): ReadonlyArray<A> =>
  text.split("\n").flatMap((line) => Option.toArray(Schema.decodeOption(schema)(line)));
