// `chernabog __stop-hook --dir <session dir> [--person]`: Claude's Stop hook
// for an interactive session. The session is done once the agent has written a
// valid answer file; until then the hook sends the agent back to write it,
// three times at most, unless a person works in the session. Under every
// launcher, `done` is how Chernabog knows.

import { type Json, parseJson, printJson } from "@chernabog/sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as JsonSchema from "effect/JsonSchema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

import { Done, readDecoded, readText, type SessionFiles, sessionFilesIn } from "./session-files.ts";

export const MAX_BLOCKS = 3;

const JsonFile = Schema.fromJsonString(Schema.Json);

// The answer, or what is wrong with it.
export const checkAnswer = (
  schema: Option.Option<Json>,
  text: Option.Option<string>,
): Result.Result<Json, string> => {
  if (Option.isNone(text)) {
    return Result.fail("There is no answer file yet.");
  }

  const answer = parseJson(text.value);

  if (Option.isNone(answer)) {
    return Result.fail("The answer file is not valid JSON.");
  }

  // A schema that isn't an object (`true`) accepts anything.
  const objectSchema = Option.filter(schema, Predicate.isObject);

  if (Option.isNone(objectSchema)) {
    return Result.succeed(answer.value);
  }

  const decoder = SchemaRepresentation.fromJsonSchemaDocument(
    JsonSchema.fromSchemaDraft2020_12(objectSchema.value),
  );

  return Schema.decodeResult(Schema.toType(decoder))(answer.value).pipe(
    Result.map(() => answer.value),
    Result.mapError((issue) => `The answer doesn't match the schema: ${issue.message}`),
  );
};

const writeDone = (files: SessionFiles, done: Done) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(files.done, yield* Schema.encodeEffect(Done)(done));
  });

// What the hook prints: a block with its reason, or nothing to let the session
// stop. With a person, it never blocks: the agent stopping waits on them.
export const stopHook = (dir: string, withPerson = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = sessionFilesIn(dir);

    // A later stop, after the answer: a background task woke the session.
    if (yield* fs.exists(files.done)) {
      return Option.none<string>();
    }

    const schema = yield* readDecoded(JsonFile, files.schema);
    const checked = checkAnswer(schema, yield* readText(files.answer));

    if (Result.isSuccess(checked)) {
      yield* writeDone(files, { ok: true });

      return Option.none<string>();
    }

    if (withPerson) {
      return Option.none<string>();
    }

    const blocks = Option.getOrElse(
      Option.filter(
        Option.map(yield* readText(files.blocks), (text) => Number.parseInt(text, 10)),
        Number.isFinite,
      ),
      () => 0,
    );

    if (blocks >= MAX_BLOCKS) {
      yield* writeDone(files, {
        ok: false,
        reason: `no valid answer after ${MAX_BLOCKS} reminders: ${checked.failure}`,
      });

      return Option.none<string>();
    }

    yield* fs.writeFileString(files.blocks, String(blocks + 1));
    const reason = `Write your final answer as JSON matching the schema in ${files.schema} to ${files.answer}, then stop. ${checked.failure}`;

    return Option.some(printJson({ decision: "block", reason }));
  });
