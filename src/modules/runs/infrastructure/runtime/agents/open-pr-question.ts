// How a Claude session with a person finishes on the hybrid path: the agent
// drafts the pull request with `chernabog open-pr --draft`, then asks the
// person with AskUserQuestion. `chernabog __question-hook --dir <session dir>`,
// Claude's PreToolUse and PostToolUse hook on that tool, checks the question
// before it is shown and acts on the answer, so only the person's Yes hands
// the work to chernabog, and only while the worktree is as it was drafted.

import { type Json, printJson } from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import { ConfigError } from "../../../../../platform/config-error.ts";
import { Exec } from "../../../../../platform/exec.ts";
import { LaunchSpecJson } from "../launchers/shim.ts";
import { Done, readDecoded, type SessionFiles, sessionFilesIn } from "./session-files.ts";

export const OPEN_PR_HEADER = "Open PR";
export const OPEN_PR_QUESTION = "Are you satisfied with the work and want to open a PR?";
const YES = "Yes";
const NO = "No";

// What `chernabog open-pr --draft` keeps until the person answers: the answer
// it would record, and the commit it was drafted at.
export const Draft = Schema.fromJsonString(
  Schema.Struct({ head: Schema.String, answer: Schema.String }),
);

export type Draft = typeof Draft.Type;

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* (yield* Exec).run("git", args, { cwd });

    if (result.exitCode !== 0) {
      return yield* new ConfigError({
        message: `git ${args.join(" ")} in ${cwd} exited ${result.exitCode}: ${result.stderr.trim()}`,
      });
    }

    return result.stdout.trimEnd();
  });

// The worktree's HEAD, and what git status lists as uncommitted in it.
export const worktreeAt = (cwd: string) =>
  Effect.all({
    head: Effect.map(git(cwd, ["rev-parse", "HEAD"]), (head) => head.trim()),
    uncommitted: git(cwd, ["status", "--porcelain"]),
  });

export type Worktree = Effect.Success<ReturnType<typeof worktreeAt>>;

// Commits on HEAD that no remote branch has: work not yet pushed.
export const unpushedCommits = (cwd: string) =>
  Effect.map(git(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]), (count) =>
    Number.parseInt(count, 10),
  );

// Why a draft no longer stands for the worktree, if it doesn't.
export const staleness = (draft: Draft, worktree: Worktree) => {
  if (worktree.uncommitted.length > 0) {
    return Option.some(`there are uncommitted changes:\n${worktree.uncommitted}`);
  }

  if (worktree.head !== draft.head) {
    return Option.some(
      `HEAD moved from ${draft.head.slice(0, 7)} to ${worktree.head.slice(0, 7)} since the draft`,
    );
  }

  return Option.none<string>();
};

const Proposed = Schema.fromJsonString(
  Schema.Struct({ title: Schema.String, body: Schema.String }),
);

// What the person sees beside Yes: the pull request they would open.
const previewOf = (draft: Draft) =>
  Option.match(Schema.decodeOption(Proposed)(draft.answer), {
    onNone: () => draft.answer,
    onSome: (proposed) => `# ${proposed.title}\n\n${proposed.body}`,
  });

export type AskUserQuestionInput = { readonly questions: ReadonlyArray<Json> };

// The AskUserQuestion input the agent asks the person with, for a draft.
export const questionFor = (draft: Draft): AskUserQuestionInput => ({
  questions: [
    {
      header: OPEN_PR_HEADER,
      question: OPEN_PR_QUESTION,
      multiSelect: false,
      options: [
        {
          label: YES,
          description:
            "Chernabog runs the local gate, pushes, opens this pull request and asks a reviewer",
          preview: previewOf(draft),
        },
        { label: NO, description: "Keep working on it together" },
      ],
    },
  ],
});

// Records the session's answer and marks it done: chernabog's run takes it from there.
export const handOver = (files: SessionFiles, answer: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(files.answer, answer);
    yield* fs.writeFileString(files.done, yield* Schema.encodeEffect(Done)({ ok: true }));
  });

const AskedOption = Schema.Struct({
  label: Schema.String,
  preview: Schema.optionalKey(Schema.String),
});

const Asked = Schema.Struct({
  question: Schema.String,
  header: Schema.String,
  options: Schema.Array(AskedOption),
  multiSelect: Schema.optionalKey(Schema.Boolean),
});

type Asked = typeof Asked.Type;

// What Claude sends the hook; other keys are left out.
const Payload = Schema.fromJsonString(
  Schema.Struct({
    hook_event_name: Schema.String,
    tool_input: Schema.Struct({ questions: Schema.Array(Asked) }),
    tool_response: Schema.optionalKey(
      Schema.Struct({
        answers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
        annotations: Schema.optionalKey(
          Schema.Record(Schema.String, Schema.Struct({ notes: Schema.optionalKey(Schema.String) })),
        ),
      }),
    ),
  }),
);

type Payload = typeof Payload.Type;

const DRAFT_AGAIN =
  "Draft the pull request with `chernabog open-pr --draft`, then ask the question it prints.";

const deny = (reason: string) =>
  printJson({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });

const tell = (context: string) =>
  printJson({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
  });

// Asked as `questionFor` gives it: Yes and No, one answer, and the draft's pull request beside Yes.
const askedAsDrafted = (asked: Asked, draft: Draft) =>
  asked.multiSelect !== true &&
  Arr.map(asked.options, (option) => option.label).join("\0") === [YES, NO].join("\0") &&
  Option.exists(
    Option.flatMap(Arr.head(asked.options), (yes) => Option.fromUndefinedOr(yes.preview)),
    (preview) => preview.trim() === previewOf(draft).trim(),
  );

// The draft, and whether the worktree is still as it was drafted.
const draftState = (files: SessionFiles) =>
  Effect.gen(function* () {
    const draft = yield* readDecoded(Draft, files.draft);
    const spec = yield* readDecoded(LaunchSpecJson, files.spec);

    if (Option.isNone(draft) || Option.isNone(spec)) {
      return Option.none<{ draft: Draft; stale: Option.Option<string> }>();
    }

    const stale = yield* worktreeAt(spec.value.cwd).pipe(
      Effect.map((worktree) => staleness(draft.value, worktree)),
      Effect.catch((error) => Effect.succeedSome(`git can't read it: ${error.message}`)),
    );

    return Option.some({ draft: draft.value, stale });
  });

// Before the question is shown: refuse one that wouldn't hand over what the person sees.
const before = (files: SessionFiles, payload: Payload, asked: Asked) =>
  Effect.gen(function* () {
    if (yield* (yield* FileSystem.FileSystem).exists(files.done)) {
      return Option.some(deny("This session already handed its work to chernabog."));
    }

    if (payload.tool_input.questions.length > 1) {
      return Option.some(deny(`Ask the ${OPEN_PR_HEADER} question on its own.`));
    }

    const state = yield* draftState(files);

    if (Option.isNone(state)) {
      return Option.some(deny(`There is no draft pull request yet. ${DRAFT_AGAIN}`));
    }

    if (Option.isSome(state.value.stale)) {
      return Option.some(
        deny(
          `The draft no longer matches the worktree: ${state.value.stale.value}. ${DRAFT_AGAIN}`,
        ),
      );
    }

    if (!askedAsDrafted(asked, state.value.draft)) {
      return Option.some(
        deny(
          `Ask it exactly as chernabog open-pr --draft printed it, with this AskUserQuestion input:\n${printJson(questionFor(state.value.draft))}`,
        ),
      );
    }

    return Option.none<string>();
  });

const withNotes = (said: string, notes: Option.Option<string>) =>
  Option.match(notes, {
    onNone: () => said,
    onSome: (note) => `${said} Their note: ${note}`,
  });

// After the person answers: their Yes hands the draft over; anything else keeps the session going.
const after = (files: SessionFiles, payload: Payload, asked: Asked) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const response = Option.fromUndefinedOr(payload.tool_response);

    const answer = Option.flatMap(response, (found) =>
      Option.flatMap(Option.fromUndefinedOr(found.answers), Record.get(asked.question)),
    );

    const notes = Option.flatMap(response, (found) =>
      Option.flatMap(Option.fromUndefinedOr(found.annotations), (annotations) =>
        Option.flatMap(Record.get(annotations, asked.question), (annotation) =>
          Option.fromUndefinedOr(annotation.notes),
        ),
      ),
    );

    if (yield* fs.exists(files.done)) {
      return tell("This session already handed its work to chernabog.");
    }

    if (!Option.contains(answer, YES)) {
      yield* fs.remove(files.draft, { force: true });

      const said = Option.match(
        Option.filter(answer, (text) => text !== NO),
        {
          onNone: () => "The person isn't ready to open the pull request.",
          onSome: (text) =>
            `The person answered "${text}" instead of Yes, so nothing was handed to chernabog.`,
        },
      );

      return tell(
        withNotes(
          `${said} Keep working with them, and when you both think it's done, draft and ask again.`,
          notes,
        ),
      );
    }

    const state = yield* draftState(files);

    if (Option.isNone(state)) {
      return tell(`The person said Yes, but there is no draft to hand over. ${DRAFT_AGAIN}`);
    }

    if (Option.isSome(state.value.stale)) {
      return tell(
        `The person said Yes, but the draft no longer matches the worktree (${state.value.stale.value}), so nothing was handed over. ${DRAFT_AGAIN}`,
      );
    }

    yield* handOver(files, state.value.draft.answer);
    yield* fs.remove(files.draft, { force: true });

    return tell(
      withNotes(
        "The person said Yes, and the work is handed to chernabog: it runs the local gate, pushes the branch, opens the pull request, waits for CI and asks a reviewer from the pool. Tell the person; this session stays open for them to close, and opens again if a review asks for changes. Make no more commits.",
        notes,
      ),
    );
  });

// What the hook prints for a payload, if anything. Only the Open PR question is
// its business; any other question, or a payload it can't read, passes.
export const questionHook = (dir: string, input: string) =>
  Effect.gen(function* () {
    const payload = Schema.decodeOption(Payload)(input);
    const files = sessionFilesIn(dir);

    const asked = Option.flatMap(payload, (found) =>
      Arr.findFirst(found.tool_input.questions, (question) => question.header === OPEN_PR_HEADER),
    );

    if (Option.isNone(payload) || Option.isNone(asked)) {
      return Option.none<string>();
    }

    if (payload.value.hook_event_name === "PreToolUse") {
      return yield* before(files, payload.value, asked.value);
    }

    if (payload.value.hook_event_name === "PostToolUse") {
      return Option.some(yield* after(files, payload.value, asked.value));
    }

    return Option.none<string>();
  });
