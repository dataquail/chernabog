// A checkout's files on disk, by path under its root.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

import { ChernabogDirClient } from "../../domain/ports/clients/chernabog-dir.client.ts";
import { RecipeFilesFailed } from "../../domain/recipe/recipe.errors.ts";

const failed = (error: { readonly message: string }) =>
  new RecipeFilesFailed({ message: error.message });

export const ChernabogDirClientLive = Layer.effect(
  ChernabogDirClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const read = (root: string, path: string) =>
      Effect.gen(function* () {
        const file = `${root}/${path}`;

        if (!(yield* fs.exists(file))) {
          return Option.none<string>();
        }

        return Option.some(yield* fs.readFileString(file));
      }).pipe(Effect.mapError(failed));

    const write = (root: string, path: string, text: string) =>
      Effect.gen(function* () {
        const file = `${root}/${path}`;
        yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
        yield* fs.writeFileString(file, text);
      }).pipe(Effect.mapError(failed));

    const append = (root: string, path: string, text: string) =>
      fs.writeFileString(`${root}/${path}`, text, { flag: "a" }).pipe(Effect.mapError(failed));

    const list = (root: string, path: string) =>
      fs.readDirectory(`${root}/${path}`).pipe(
        Effect.map((names) => Arr.sort(names, Order.String)),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );

    return ChernabogDirClient.of({ read, write, append, list });
  }),
);
