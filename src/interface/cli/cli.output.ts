// How a command says what happened: lines on stdout, a failure on stderr with
// a failing exit code, or a use-case's result as JSON for a script to read.

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const printLines = (lines: Iterable<string>) =>
  Effect.forEach(lines, (line) => Console.log(line), { discard: true });

export const fail = (message: string) =>
  Effect.gen(function* () {
    yield* Console.error(message);
    process.exitCode = 1;
  });

// A result as JSON, through its schema, so a script reads what the use-case
// returned rather than what a person is shown.
export const printJson = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S["Type"]) =>
  Schema.encodeEffect(Schema.fromJsonString(schema, { space: 2 }))(value).pipe(
    Effect.orDie,
    Effect.flatMap((json) => Console.log(json)),
  );
