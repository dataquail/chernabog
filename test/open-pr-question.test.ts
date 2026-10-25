// How a session with a person finishes: the agent drafts the pull request with
// `chernabog open-pr --draft`, asks the person with AskUserQuestion, and the
// question hook hands the draft over only on their Yes. The Stop hook reminds
// the agent, once for each new commit, to offer it.

import { Hybrid, type Json, parseJson, printJson } from "@chernabog/sdk";
import { BunServices } from "@effect/platform-bun";
import { describe, expect } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { it } from "effect-bun-test";

import { openPr } from "../src/interface/cli/runs/open-pr.main.ts";
import {
  Draft,
  OPEN_PR_HEADER,
  OPEN_PR_QUESTION,
  questionFor,
  questionHook,
} from "../src/modules/runs/infrastructure/runtime/agents/open-pr-question.ts";
import {
  Done,
  SESSION_ENV,
  sessionFilesIn,
} from "../src/modules/runs/infrastructure/runtime/agents/session-files.ts";
import { stopHook } from "../src/modules/runs/infrastructure/runtime/agents/stop-hook.ts";
import { LaunchSpecJson } from "../src/modules/runs/infrastructure/runtime/launchers/shim.ts";
import { HostEnvironment } from "../src/platform/environment.ts";
import { Exec, execOk } from "../src/platform/exec.ts";

// Each test's directory, removed after it: a worktree, and the session on it.
class Scratch extends Context.Service<Scratch, { readonly root: string }>()("test/Scratch") {}

const ScratchLive = Layer.effect(
  Scratch,
  FileSystem.FileSystem.use((fs) =>
    fs.makeTempDirectoryScoped({ prefix: "chernabog-open-pr-" }),
  ).pipe(Effect.map((root) => Scratch.of({ root }))),
);

// The session's directory in the environment, as Claude's is for `chernabog open-pr`.
const SessionEnvironment = Layer.unwrap(
  Scratch.use(({ root }) =>
    Effect.succeed(HostEnvironment.fixed({ [SESSION_ENV]: `${root}/session` })),
  ),
);

const effect = it.scopedLive.layer(
  Layer.mergeAll(Exec.layer, SessionEnvironment).pipe(
    Layer.provideMerge(ScratchLive),
    Layer.provideMerge(BunServices.layer),
  ),
);

const TITLE = "feat: do the thing";
const BODY = "Adds the thing.";

const git = (cwd: string, ...args: Array<string>) =>
  execOk("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd });

const commit = (cwd: string, name: string) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem).writeFileString(`${cwd}/${name}`, `${name}\n`);
    yield* git(cwd, "add", ".");
    yield* git(cwd, "commit", "-qm", `feat: ${name}`);
  });

// A worktree with a commit, and a session on it waiting for a pull request (or the schema given).
const session = (schema: Json = Hybrid.finishedJsonSchema) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root } = yield* Scratch;
    const worktree = `${root}/worktree`;
    const files = sessionFilesIn(`${root}/session`);
    yield* fs.makeDirectory(worktree);
    yield* fs.makeDirectory(files.dir);
    yield* git(worktree, "init", "-q");
    yield* commit(worktree, "first");

    const spec = { command: "claude", args: [], cwd: worktree, env: {} };
    yield* fs.writeFileString(files.spec, yield* Schema.encodeEffect(LaunchSpecJson)(spec));
    yield* fs.writeFileString(files.schema, printJson(schema));

    return { worktree, files };
  });

type Session = Effect.Success<ReturnType<typeof session>>;

const runDraft = openPr({
  title: TITLE,
  body: Option.some(BODY),
  bodyFile: Option.none(),
  summary: Option.none(),
  draft: true,
});

const draftIn = ({ files }: Session) =>
  Effect.gen(function* () {
    yield* runDraft;
    const text = yield* (yield* FileSystem.FileSystem).readFileString(files.draft);

    return yield* Schema.decodeEffect(Draft)(text);
  });

const asked = (draft: Draft) => questionFor(draft);

const payload = (
  event: string,
  questions: ReadonlyArray<Json>,
  answers: Record<string, string> = {},
) =>
  printJson({
    hook_event_name: event,
    tool_name: "AskUserQuestion",
    tool_input: { questions },
    tool_response: { questions, answers },
  });

const before = ({ files }: Session, questions: ReadonlyArray<Json>) =>
  questionHook(files.dir, payload("PreToolUse", questions));

const answering = ({ files }: Session, questions: ReadonlyArray<Json>, answer: string) =>
  questionHook(files.dir, payload("PostToolUse", questions, { [OPEN_PR_QUESTION]: answer }));

const Said = Schema.fromJsonString(
  Schema.Struct({
    decision: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.String),
    hookSpecificOutput: Schema.optionalKey(
      Schema.Struct({
        permissionDecision: Schema.optionalKey(Schema.String),
        permissionDecisionReason: Schema.optionalKey(Schema.String),
        additionalContext: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
);

const said = (printed: Option.Option<string>) =>
  Schema.decodeSync(Said)(Option.getOrThrow(printed));

// What a hook told Claude: a refusal's reason, the context after an answer, or a block's reason.
const reason = (printed: Option.Option<string>) => {
  const { hookSpecificOutput: specific, reason: blocked } = said(printed);

  return specific?.permissionDecisionReason ?? specific?.additionalContext ?? blocked ?? "";
};

const decision = (printed: Option.Option<string>) => {
  const { decision: blocked, hookSpecificOutput: specific } = said(printed);

  return specific?.permissionDecision ?? blocked;
};

describe("chernabog open-pr --draft", () => {
  effect("keeps the pull request as a draft, ends nothing, and prints the question to ask", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const opened = yield* session();
      const draft = yield* draftIn(opened);

      expect(yield* fs.exists(opened.files.answer)).toBe(false);
      expect(yield* fs.exists(opened.files.done)).toBe(false);
      expect(parseJson(draft.answer)).toEqual(
        Option.some({ title: TITLE, body: BODY, summary: TITLE }),
      );

      const lines = yield* runDraft;
      expect(lines[0]).toContain("only their Yes hands the work to chernabog");
      expect(lines[1]).toBe(printJson(questionFor(draft)));
      expect(lines[1]).toContain(`"header":"${OPEN_PR_HEADER}"`);
      expect(lines[1]).toContain(printJson(`# ${TITLE}\n\n${BODY}`));
    }),
  );
});

describe("the question hook, before the person sees the question", () => {
  effect("lets other questions through, and the Open PR question only as drafted", () =>
    Effect.gen(function* () {
      const opened = yield* session();

      const other = {
        question: "Which?",
        header: "Pick",
        options: [{ label: "A" }, { label: "B" }],
      };

      expect(yield* before(opened, [other])).toEqual(Option.none());

      const draft = yield* draftIn(opened);
      const [question] = asked(draft).questions;
      expect(yield* before(opened, [question])).toEqual(Option.none());

      const withoutPreview = {
        header: OPEN_PR_HEADER,
        question: OPEN_PR_QUESTION,
        options: [{ label: "Yes" }, { label: "No" }],
      };

      const refused = yield* before(opened, [withoutPreview]);
      expect(decision(refused)).toBe("deny");
      expect(reason(refused)).toContain("Ask it exactly as chernabog open-pr --draft printed it");

      expect(reason(yield* before(opened, [question, other]))).toContain("on its own");
    }),
  );

  effect("refuses it without a draft, or once the worktree moved on from it", () =>
    Effect.gen(function* () {
      const opened = yield* session();
      const draft = yield* draftIn(opened);
      const [question] = asked(draft).questions;
      yield* (yield* FileSystem.FileSystem).remove(opened.files.draft);
      expect(reason(yield* before(opened, [question]))).toContain("There is no draft");

      yield* draftIn(opened);
      yield* commit(opened.worktree, "second");
      expect(reason(yield* before(opened, [question]))).toContain("HEAD moved");
    }),
  );
});

describe("the question hook, once the person answers", () => {
  effect("hands the draft over on Yes, and ends the session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const opened = yield* session();
      const draft = yield* draftIn(opened);
      const told = yield* answering(opened, asked(draft).questions, "Yes");

      expect(reason(told)).toContain("the work is handed to chernabog");
      expect(yield* fs.readFileString(opened.files.answer)).toBe(draft.answer);
      expect(yield* Schema.decodeEffect(Done)(yield* fs.readFileString(opened.files.done))).toEqual(
        { ok: true },
      );
      expect(yield* fs.exists(opened.files.draft)).toBe(false);
    }),
  );

  effect("on No, or anything but Yes, drops the draft and keeps the session going", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const opened = yield* session();

      const no = yield* answering(opened, asked(yield* draftIn(opened)).questions, "No");
      expect(reason(no)).toContain("isn't ready");
      expect(yield* fs.exists(opened.files.draft)).toBe(false);

      const typed = yield* answering(
        opened,
        asked(yield* draftIn(opened)).questions,
        "Rename the flag first",
      );

      expect(reason(typed)).toContain('answered "Rename the flag first" instead of Yes');
      expect(yield* fs.exists(opened.files.done)).toBe(false);
      expect(yield* fs.exists(opened.files.answer)).toBe(false);
    }),
  );

  effect("hands nothing over on a Yes to a draft the worktree moved on from", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const opened = yield* session();
      const draft = yield* draftIn(opened);
      yield* commit(opened.worktree, "second");

      const told = yield* answering(opened, asked(draft).questions, "Yes");
      expect(reason(told)).toContain("nothing was handed over");
      expect(yield* fs.exists(opened.files.done)).toBe(false);
    }),
  );
});

describe("the Stop hook, with a person", () => {
  effect("reminds the agent to offer the pull request, once for each new commit", () =>
    Effect.gen(function* () {
      const opened = yield* session();
      const reminded = yield* stopHook(opened.files.dir, true);
      expect(decision(reminded)).toBe("block");
      expect(reason(reminded)).toContain("chernabog open-pr --draft");
      expect(yield* stopHook(opened.files.dir, true)).toEqual(Option.none());

      yield* commit(opened.worktree, "second");
      expect(Option.isSome(yield* stopHook(opened.files.dir, true))).toBe(true);
    }),
  );

  effect("doesn't, with uncommitted changes, nothing unpushed, or a draft already out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const opened = yield* session();
      yield* fs.writeFileString(`${opened.worktree}/wip.txt`, "wip\n");
      expect(yield* stopHook(opened.files.dir, true)).toEqual(Option.none());
      yield* fs.remove(`${opened.worktree}/wip.txt`);

      yield* draftIn(opened);
      expect(yield* stopHook(opened.files.dir, true)).toEqual(Option.none());
      yield* fs.remove(opened.files.draft);

      yield* git(opened.worktree, "update-ref", "refs/remotes/origin/main", "HEAD");
      expect(yield* stopHook(opened.files.dir, true)).toEqual(Option.none());
    }),
  );

  effect("doesn't in a session that answers something else, such as a review", () =>
    Effect.gen(function* () {
      const opened = yield* session({
        type: "object",
        properties: { status: { type: "string" }, reasons: { type: "string" } },
        required: ["status", "reasons"],
        additionalProperties: false,
      });

      expect(yield* stopHook(opened.files.dir, true)).toEqual(Option.none());
    }),
  );
});
