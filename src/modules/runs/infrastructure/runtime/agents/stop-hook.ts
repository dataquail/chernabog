// `chernabog __stop-hook --dir <session dir> [--person]`: Claude's Stop hook
// for an interactive session. The session is done once the agent has written a
// valid answer file; until then the hook sends the agent back to write it,
// three times at most, unless a person works in the session. Then it only
// reminds the agent, once for each new commit, to offer the pull request.
// Under every launcher, `done` is how Chernabog knows.

import { type Json, parseJson, printJson } from "@chernabog/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as JsonSchema from "effect/JsonSchema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

import { LaunchSpecJson } from "../launchers/shim.ts";
import { Draft, unpushedCommits, worktreeAt } from "./open-pr-question.ts";
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

// Whether the session waits for `chernabog open-pr`: its schema takes a pull request.
export const awaitsPullRequest = (schema: Option.Option<Json>) =>
  Option.isSome(schema) &&
  Result.isSuccess(
    checkAnswer(schema, Option.some(printJson({ title: "", body: "", summary: "" }))),
  );

// A block that reminds the agent to offer the pull request: once for each HEAD,
// when it has unpushed commits, nothing uncommitted, and no draft yet.
const reminder = (files: SessionFiles, schema: Option.Option<Json>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spec = yield* readDecoded(LaunchSpecJson, files.spec);

    if (!awaitsPullRequest(schema) || Option.isNone(spec)) {
      return Option.none<string>();
    }

    const worktree = yield* worktreeAt(spec.value.cwd);
    const reminded = yield* readText(files.reminded);
    const draft = yield* readDecoded(Draft, files.draft);

    if (
      worktree.uncommitted.length > 0 ||
      Option.contains(reminded, worktree.head) ||
      Option.exists(draft, (drafted) => drafted.head === worktree.head) ||
      (yield* unpushedCommits(spec.value.cwd)) === 0
    ) {
      return Option.none<string>();
    }

    yield* fs.writeFileString(files.reminded, worktree.head);

    const reason =
      "The work is committed. If you and the person think it's done, draft the pull request with `chernabog open-pr --draft` and ask them the question it prints. If not, carry on with them; this reminder comes once for each new commit.";

    return Option.some(printJson({ decision: "block", reason }));
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

const writeDone = (files: SessionFiles, done: Done) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(files.done, yield* Schema.encodeEffect(Done)(done));
  });

// What the hook prints: a block with its reason, or nothing to let the session
// stop. With a person, it blocks only to remind the agent to offer the pull
// request: otherwise the agent stopping waits on them.
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
      return yield* reminder(files, schema);
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
