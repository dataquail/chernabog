// Every answer an agent gave in a run, by step, with the commits its step
// made: what `chernabog rehearse --replay <run>` stands in with (#115).

import { decodeJsonLines } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Exec } from "../../../../../platform/exec.ts";
import { Home, homePaths } from "../../../../../platform/home.ts";

export const AnswerRecord = Schema.Struct({
  step: Schema.String,
  adapter: Schema.String,
  answer: Schema.Json,
  // The subjects of the commits made while the agent worked, oldest first.
  commits: Schema.Array(Schema.String),
  at: Schema.String,
});

export type AnswerRecord = typeof AnswerRecord.Type;

const AnswerLine = Schema.fromJsonString(AnswerRecord);

const answersFile = (root: string, runId: string) =>
  `${homePaths(root).sessions}/runs/${runId}.answers.jsonl`;

// The commit a worktree is on, or none outside a git checkout.
export const headOf = (cwd: string) =>
  Effect.gen(function* () {
    const result = yield* (yield* Exec).run("git", ["rev-parse", "HEAD"], { cwd });

    return Option.liftPredicate(result.stdout.trim(), () => result.exitCode === 0);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

// The subjects of the commits on top of `since`, oldest first.
export const commitsSince = (cwd: string, since: Option.Option<string>) =>
  Option.match(since, {
    onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
    onSome: (sha) =>
      Effect.gen(function* () {
        const result = yield* (yield* Exec).run(
          "git",
          ["log", "--reverse", "--format=%s", `${sha}..HEAD`],
          { cwd },
        );

        if (result.exitCode !== 0) {
          return [];
        }

        return result.stdout.split("\n").filter((line) => line.length > 0);
      }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
  });

export const recordAnswer = (runId: string, record: Omit<AnswerRecord, "at">) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = (yield* Home).root;
    yield* fs.makeDirectory(`${homePaths(root).sessions}/runs`, { recursive: true });
    const at = DateTime.formatIso(yield* DateTime.now);
    const line = yield* Schema.encodeEffect(AnswerLine)({ ...record, at });
    yield* fs.writeFileString(answersFile(root, runId), `${line}\n`, { flag: "a" });
  }).pipe(Effect.orDie);

// A run's answers, oldest first; for a step answered twice, such as one
// retried after a crash, the last answer.
export const runAnswers = (runId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = answersFile((yield* Home).root, runId);

    if (!(yield* fs.exists(file))) {
      return Option.none<ReadonlyArray<AnswerRecord>>();
    }

    const records = decodeJsonLines(AnswerLine, yield* fs.readFileString(file));

    return Option.some(
      Arr.filter(records, (record, index) =>
        records.slice(index + 1).every((later) => later.step !== record.step),
      ),
    );
  }).pipe(Effect.orElseSucceed(() => Option.none<ReadonlyArray<AnswerRecord>>()));
