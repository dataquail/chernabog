import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";

import { ChernabogDirClient } from "../../domain/ports/clients/chernabog-dir.client.ts";

// A checkout's files in memory, by `${root}/${path}`, in `files`, which the
// client writes to as well, so a test reads back what it wrote.
export const ChernabogDirClientFake = (files: Record<string, string>) =>
  Layer.succeed(
    ChernabogDirClient,
    ChernabogDirClient.of({
      read: (root, path) => Effect.sync(() => Record.get(files, `${root}/${path}`)),
      write: (root, path, text) =>
        Effect.sync(() => {
          files[`${root}/${path}`] = text;
        }),
      append: (root, path, text) =>
        Effect.sync(() => {
          files[`${root}/${path}`] =
            `${Option.getOrElse(Record.get(files, `${root}/${path}`), () => "")}${text}`;
        }),
      list: (root, path) =>
        Effect.sync(() =>
          Arr.sort(
            Arr.dedupe(
              Object.keys(files)
                .filter((file) => file.startsWith(`${root}/${path}/`))
                .map((file) => file.slice(`${root}/${path}/`.length).split("/")[0]),
            ),
            Order.String,
          ),
        ),
    }),
  );
