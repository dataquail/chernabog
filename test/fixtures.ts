// Recorded GitHub and usage responses under fixtures/, decoded with the schema
// the app decodes them with.

import { fileURLToPath } from "node:url";

import type { Json } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export const fixture = <A>(name: string, schema: Schema.Codec<A, Json>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const text = yield* fs.readFileString(
      fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
    );

    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text);
  }).pipe(Effect.orDie);
