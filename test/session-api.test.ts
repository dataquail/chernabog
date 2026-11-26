// The hub's session API (ADR 24, #713, #715): a TCP listener whose only routes
// are one session's stop, question, answer and allowlisted commands, each
// reached with that session's token alone, and only while the session's
// `__launch` runs and the run that launched it is live. The stop
// and question routes decide what the Stop and AskUserQuestion hooks decide
// today, case for case.

import { Hybrid, type Json, printJson } from "@chernabog/sdk";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { it } from "effect-bun-test";

import * as DefaultPrompts from "../packages/sdk/src/default-prompts.ts";
import {
  openSessionApi,
  SESSION_COMMANDS,
  type SessionApi,
} from "../src/interface/daemon/session-api.server.ts";
import { withAnswerFile } from "../src/modules/runs/infrastructure/runtime/agents/claude-interactive.ts";
import {
  Draft,
  questionFor,
  questionHook,
} from "../src/modules/runs/infrastructure/runtime/agents/open-pr-question.ts";
import {
  LaunchRecord,
  sessionFiles,
} from "../src/modules/runs/infrastructure/runtime/agents/session-files.ts";
import {
  MAX_BLOCKS,
  stopHook,
} from "../src/modules/runs/infrastructure/runtime/agents/stop-hook.ts";
import { shellCommand } from "../src/modules/runs/infrastructure/runtime/launchers/launcher.ts";
import { LaunchSpecJson } from "../src/modules/runs/infrastructure/runtime/launchers/shim.ts";
import { Exec, execOk } from "../src/platform/exec.ts";
import { spawnGroup, stopGroup } from "../src/platform/process-group.ts";
import { selfCommand } from "../src/platform/self.ts";
import { sessionToken } from "../src/platform/session-token.ts";

const effect = it.scopedLive.layer(
  Layer.mergeAll(Exec.layer, FetchHttpClient.layer).pipe(Layer.provideMerge(BunServices.layer)),
);

const RUN = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN = "22222222-2222-4222-8222-222222222222";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ANSWER_SCHEMA: Json = {
  type: "object",
  properties: { status: { type: "string" } },
  required: ["status"],
  additionalProperties: false,
};

const git = (cwd: string, ...args: Array<string>) =>
  execOk("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd });

const commit = (cwd: string, name: string) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem).writeFileString(`${cwd}/${name}`, `${name}\n`);
    yield* git(cwd, "add", ".");
    yield* git(cwd, "commit", "-qm", `feat: ${name}`);
  });

// A chernabog home with a live run, and its session API open.
const hub = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "chernabog-session-api-" });
  const live = yield* Ref.make<ReadonlySet<string>>(new Set([RUN, OTHER_RUN]));

  const api = yield* openSessionApi({
    root,
    isLive: (runId) => Effect.map(Ref.get(live), (runs) => runs.has(runId)),
    log: () => Effect.void,
    gateways: [],
  });

  const end = (runId: string) =>
    Ref.update(live, (runs) => new Set([...runs].filter((run) => run !== runId)));

  return { root, api, end };
});

// A stand-in for a session's `chernabog __launch <spec>`: a process whose
// command line names the spec, its pid in agent.pid, stopped with the scope.
// Its `stop` ends it and waits until it has gone.
const launch = (files: ReturnType<typeof sessionFiles>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const group = yield* Effect.acquireRelease(
      spawnGroup("sh", ["-c", "sleep 600; :", "launch", files.spec], {
        cwd: files.dir,
        env: { PATH: "/bin:/usr/bin" },
      }),
      (started) => started.signal("SIGKILL"),
    );

    yield* fs.writeFileString(files.pid, String(group.pid));

    return { pid: group.pid, stop: Effect.asVoid(stopGroup(group, Duration.seconds(5))) };
  });

// A session in the home: a worktree with a commit, its spec, its schema,
// whether a person works in it, the run that launched it, and its running
// `__launch`.
const session = (
  root: string,
  sessionId: string,
  options: { schema?: Json; withPerson?: boolean; runId?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = sessionFiles(root, sessionId);
    const worktree = `${root}/worktrees/${sessionId}`;
    yield* fs.makeDirectory(worktree, { recursive: true });
    yield* fs.makeDirectory(files.dir, { recursive: true });
    yield* git(worktree, "init", "-q");
    yield* commit(worktree, "first");

    const spec = { command: "claude", args: [], cwd: worktree, env: {} };
    yield* fs.writeFileString(files.spec, yield* Schema.encodeEffect(LaunchSpecJson)(spec));
    yield* fs.writeFileString(files.schema, printJson(options.schema ?? ANSWER_SCHEMA));

    const record = {
      launcher: { name: "tmux", from: "machine", custom: Option.none() },
      handle: "chernabog:1",
      at: "2026-11-25T00:00:00.000Z",
      withPerson: options.withPerson ?? false,
      runId: options.runId ?? RUN,
    };

    yield* fs.writeFileString(files.launch, yield* Schema.encodeEffect(LaunchRecord)(record));

    return { files, worktree, launched: yield* launch(files) };
  });

const tokenFor = (api: SessionApi, runId: string, sessionId: string) =>
  sessionToken(api.runKey(runId), sessionId);

type Call = {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly method?: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly token?: string;
};

const call = (api: SessionApi, { body, headers = {}, method = "POST", path, token }: Call) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const bearer = Option.map(Option.fromUndefinedOr(token), (held) => `Bearer ${held}`);

    let request = HttpClientRequest.make(method)(`http://127.0.0.1:${api.port}${path}`, {
      headers,
    });

    if (Option.isSome(bearer)) {
      request = HttpClientRequest.setHeader(request, "authorization", bearer.value);
    }

    const text = Option.fromUndefinedOr(body);

    if (Option.isSome(text)) {
      request = HttpClientRequest.bodyText(request, text.value, "application/json");
    }

    const response = yield* client.execute(request);

    return { status: response.status, text: yield* response.text };
  }).pipe(Effect.orDie);

const routeOf = (runId: string, sessionId: string, route: string) =>
  `/runs/${runId}/sessions/${sessionId}/${route}`;

const STOP_INPUT = printJson({ hook_event_name: "Stop", stop_hook_active: false });

describe("the session API's token", () => {
  effect("reaches its own session's routes, and no other session's or run's", () =>
    Effect.gen(function* () {
      const { api, root } = yield* hub;
      yield* session(root, SESSION);
      yield* session(root, OTHER_SESSION);
      const token = tokenFor(api, RUN, SESSION);

      const own = yield* call(api, {
        path: routeOf(RUN, SESSION, "stop"),
        token,
        body: STOP_INPUT,
      });

      expect(own.status).toBe(200);

      const otherSession = yield* call(api, {
        path: routeOf(RUN, OTHER_SESSION, "stop"),
        token,
        body: STOP_INPUT,
      });

      expect(otherSession.status).toBe(401);

      const otherRun = yield* call(api, {
        path: routeOf(OTHER_RUN, SESSION, "stop"),
        token,
        body: STOP_INPUT,
      });

      expect(otherRun.status).toBe(401);

      for (const route of ["stop", "question"]) {
        const without = yield* call(api, { path: routeOf(RUN, SESSION, route), body: "{}" });
        expect(without.status).toBe(401);
      }

      const answered = yield* call(api, {
        method: "PUT",
        path: routeOf(RUN, OTHER_SESSION, "answer"),
        token,
        body: printJson({ status: "done" }),
      });

      expect(answered.status).toBe(401);
      expect(
        yield* (yield* FileSystem.FileSystem).exists(sessionFiles(root, OTHER_SESSION).answer),
      ).toBe(false);
    }),
  );

  effect("never reaches the daemon's commands, the dashboard or anything but session routes", () =>
    Effect.gen(function* () {
      const { api, root } = yield* hub;
      yield* session(root, SESSION);
      const token = tokenFor(api, RUN, SESSION);

      for (const path of [
        "/commands/PauseRepoCommand",
        "/commands/EnrollRepoCommand",
        "/dashboard/start",
        "/api/commands/PauseRepoCommand",
        "/run",
        "/cancel",
        "/status",
        "/",
        `/runs/${RUN}/attach`,
        `/runs/${RUN}/sessions/${SESSION}`,
        `/runs/${RUN}/sessions/${SESSION}/../../../commands/PauseRepoCommand`,
        `/runs/${RUN}/sessions/${SESSION}%2f..%2f..%2fcommands/stop`,
      ]) {
        const read = yield* call(api, { method: "GET", path, token });
        expect([path, "GET", read.status]).toEqual([path, "GET", 404]);

        const sent = yield* call(api, { body: "{}", path, token });
        expect([path, "POST", sent.status]).toEqual([path, "POST", 404]);
      }
    }),
  );

  effect("stops working once the run that launched its session ends", () =>
    Effect.gen(function* () {
      const { api, end, root } = yield* hub;
      const { files } = yield* session(root, SESSION);
      const token = tokenFor(api, RUN, SESSION);

      yield* end(RUN);

      for (const route of ["stop", "question"]) {
        const refused = yield* call(api, {
          path: routeOf(RUN, SESSION, route),
          token,
          body: STOP_INPUT,
        });

        expect([route, refused.status]).toEqual([route, 410]);
      }

      const answered = yield* call(api, {
        method: "PUT",
        path: routeOf(RUN, SESSION, "answer"),
        token,
        body: printJson({ status: "done" }),
      });

      expect(answered.status).toBe(410);

      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(files.answer)).toBe(false);
      expect(yield* fs.exists(files.blocks)).toBe(false);
    }),
  );

  effect("reaches no session its run didn't launch, even minted with that run's key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { api, root } = yield* hub;
      const { files } = yield* session(root, OTHER_SESSION, { runId: OTHER_RUN });

      // A token minted with RUN's key for a session OTHER_RUN launched.
      const token = tokenFor(api, RUN, OTHER_SESSION);

      const refused = yield* call(api, {
        path: routeOf(RUN, OTHER_SESSION, "stop"),
        token,
        body: STOP_INPUT,
      });

      expect(refused.status).toBe(404);

      const answered = yield* call(api, {
        method: "PUT",
        path: routeOf(RUN, OTHER_SESSION, "answer"),
        token,
        body: printJson({ status: "done" }),
      });

      expect(answered.status).toBe(404);
      expect(yield* fs.exists(files.answer)).toBe(false);
      expect(yield* fs.exists(files.blocks)).toBe(false);

      // Its own run's token still reaches it.
      const own = yield* call(api, {
        path: routeOf(OTHER_RUN, OTHER_SESSION, "stop"),
        token: tokenFor(api, OTHER_RUN, OTHER_SESSION),
        body: STOP_INPUT,
      });

      expect(own.status).toBe(200);
    }),
  );

  effect("stops working once its session's __launch exits, and again while a resume runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { api, root } = yield* hub;
      const { files, launched } = yield* session(root, SESSION);
      const token = tokenFor(api, RUN, SESSION);

      const stopAt = () =>
        Effect.map(
          call(api, { path: routeOf(RUN, SESSION, "stop"), token, body: STOP_INPUT }),
          (said) => said.status,
        );

      expect(yield* stopAt()).toBe(200);

      // The launch exits but leaves agent.pid naming its dead pid.
      yield* launched.stop;

      for (const route of ["stop", "question"]) {
        const refused = yield* call(api, {
          path: routeOf(RUN, SESSION, route),
          token,
          body: STOP_INPUT,
        });

        expect([route, refused.status]).toEqual([route, 410]);
      }

      const answered = yield* call(api, {
        method: "PUT",
        path: routeOf(RUN, SESSION, "answer"),
        token,
        body: printJson({ status: "done" }),
      });

      expect(answered.status).toBe(410);
      expect(yield* fs.exists(files.answer)).toBe(false);

      // __launch removed agent.pid as it exited.
      yield* fs.remove(files.pid);
      expect(yield* stopAt()).toBe(410);

      // A reused pid, a live process that isn't this session's launch, doesn't revive it.
      yield* fs.writeFileString(files.pid, String(process.pid));
      expect(yield* stopAt()).toBe(410);

      // A resumed session, a new __launch, reaches its routes again.
      yield* launch(files);
      expect(yield* stopAt()).toBe(200);
    }),
  );

  effect("is refused from a browser, and on a route's wrong method", () =>
    Effect.gen(function* () {
      const { api, root } = yield* hub;
      yield* session(root, SESSION);
      const token = tokenFor(api, RUN, SESSION);

      const fromPage = yield* call(api, {
        path: routeOf(RUN, SESSION, "stop"),
        token,
        body: STOP_INPUT,
        headers: { origin: "http://evil.example" },
      });

      expect(fromPage.status).toBe(403);

      const wrong = yield* call(api, { method: "GET", path: routeOf(RUN, SESSION, "stop"), token });
      expect(wrong.status).toBe(405);
    }),
  );

  effect("binds only loopback, plus any gateway address it was given", () =>
    Effect.gen(function* () {
      const { api } = yield* hub;
      expect(api.hosts).toEqual(["127.0.0.1"]);
      expect(api.port).toBeGreaterThan(0);
    }),
  );
});

// What a hook's output says, with the session's own paths made the same, so
// the hook and the route on two sessions compare.
const normalized = (text: string, dir: string) => text.replaceAll(dir, "<session>");

// Runs the Stop hook on one session and the stop route on a twin, prepared
// the same way, and gives what each said and left in its session dir.
const stopBoth = (
  prepare: (
    setUp: Effect.Success<ReturnType<typeof session>>,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | Exec>,
  options: { schema?: Json; withPerson?: boolean } = {},
  times = 1,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { api, root } = yield* hub;
    const hooked = yield* session(root, SESSION, options);
    const routed = yield* session(root, OTHER_SESSION, options);
    yield* prepare(hooked);
    yield* prepare(routed);

    const token = tokenFor(api, RUN, OTHER_SESSION);
    const fromHook: Array<string> = [];
    const fromRoute: Array<string> = [];

    for (let at = 0; at < times; at++) {
      const printed = yield* stopHook(hooked.files.dir, options.withPerson ?? false);
      fromHook.push(
        normalized(
          Option.getOrElse(printed, () => ""),
          hooked.files.dir,
        ),
      );

      const answered = yield* call(api, {
        path: routeOf(RUN, OTHER_SESSION, "stop"),
        token,
        body: STOP_INPUT,
      });

      expect(answered.status).toBe(200);
      fromRoute.push(normalized(answered.text, routed.files.dir));
    }

    // The twins' commits are made apart, so their hashes can differ: the
    // HEAD `reminded` records is compared as each twin's own.
    const left = (setUp: typeof hooked) =>
      Effect.gen(function* () {
        const head = (yield* git(setUp.worktree, "rev-parse", "HEAD")).trim();

        return yield* Effect.forEach(
          [setUp.files.done, setUp.files.blocks, setUp.files.reminded],
          (file) =>
            fs.readFileString(file).pipe(
              Effect.map((text) => text.replaceAll(head, "<head>")),
              Effect.orElseSucceed(() => "<absent>"),
            ),
        );
      });

    const hookLeft = yield* left(hooked);
    const routeLeft = yield* left(routed);

    return { fromHook, fromRoute, hookLeft, routeLeft };
  });

const answerWith = (answer: string) => (setUp: Effect.Success<ReturnType<typeof session>>) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(setUp.files.answer, answer));

const nothing = () => Effect.void;

describe("the stop route decides as the Stop hook does", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly prepare: Parameters<typeof stopBoth>[0];
    readonly options?: { schema?: Json; withPerson?: boolean };
    // For each stop in turn, whether it sends the agent back.
    readonly blocks: ReadonlyArray<boolean>;
  }> = [
    {
      name: "a valid answer lets it stop, done",
      prepare: answerWith(printJson({ status: "ok" })),
      blocks: [false],
    },
    { name: "no answer yet sends the agent back", prepare: nothing, blocks: [true] },
    {
      name: "an answer that isn't JSON sends it back",
      prepare: answerWith("{nope"),
      blocks: [true],
    },
    {
      name: "an answer off the schema sends it back",
      prepare: answerWith(printJson({ other: 1 })),
      blocks: [true],
    },
    {
      name: `after ${MAX_BLOCKS} reminders it gives up, done not ok`,
      prepare: nothing,
      blocks: [...Array.from({ length: MAX_BLOCKS }, () => true), false, false],
    },
    {
      name: "a later stop, once done, lets it stop",
      prepare: (setUp) =>
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(setUp.files.done, printJson({ ok: true })),
        ),
      blocks: [false],
    },
    {
      name: "with a person, it reminds the agent to offer the pull request once per commit",
      prepare: nothing,
      options: { schema: Hybrid.finishedJsonSchema, withPerson: true },
      blocks: [true, false],
    },
    {
      name: "with a person and uncommitted work, it lets the agent stop",
      prepare: (setUp) =>
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(`${setUp.worktree}/wip.txt`, "wip\n"),
        ),
      options: { schema: Hybrid.finishedJsonSchema, withPerson: true },
      blocks: [false],
    },
    {
      name: "with a person, a session answering something else never blocks",
      prepare: nothing,
      options: { withPerson: true },
      blocks: [false],
    },
    {
      name: "with a person and nothing unpushed, it lets the agent stop",
      prepare: (setUp) => git(setUp.worktree, "update-ref", "refs/remotes/origin/main", "HEAD"),
      options: { schema: Hybrid.finishedJsonSchema, withPerson: true },
      blocks: [false],
    },
  ];

  for (const { blocks, name, options, prepare } of cases) {
    effect(name, () =>
      Effect.gen(function* () {
        const both = yield* stopBoth(prepare, options, blocks.length);
        expect(both.fromRoute).toEqual(both.fromHook);
        expect(both.routeLeft).toEqual(both.hookLeft);
        expect(both.fromRoute.map((said) => said.includes('"decision":"block"'))).toEqual([
          ...blocks,
        ]);
      }),
    );
  }
});

describe("the question route answers as the question hook does", () => {
  effect("refuses the Open PR question without a draft, and passes any other", () =>
    Effect.gen(function* () {
      const { api, root } = yield* hub;
      const { files } = yield* session(root, SESSION, { withPerson: true });
      const token = tokenFor(api, RUN, SESSION);

      const openPr = printJson({
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              header: "Open PR",
              question: "Open it?",
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        },
      });

      const other = printJson({
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ header: "Pick", question: "Which?", options: [{ label: "A" }] }],
        },
      });

      for (const input of [openPr, other]) {
        const hooked = yield* questionHook(files.dir, input);

        const routed = yield* call(api, {
          path: routeOf(RUN, SESSION, "question"),
          token,
          body: input,
        });

        expect(routed.status).toBe(200);
        expect(routed.text).toBe(Option.getOrElse(hooked, () => ""));
      }

      const denied = yield* call(api, {
        path: routeOf(RUN, SESSION, "question"),
        token,
        body: openPr,
      });

      expect(denied.text).toContain('"permissionDecision":"deny"');
    }),
  );
});

describe("the answer route", () => {
  effect("refuses an answer off the schema with the reason, and stores one that matches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { api, root } = yield* hub;
      const { files } = yield* session(root, SESSION);
      const token = tokenFor(api, RUN, SESSION);
      const path = routeOf(RUN, SESSION, "answer");

      const notJson = yield* call(api, { method: "PUT", path, token, body: "{nope" });
      expect(notJson.status).toBe(422);
      expect(notJson.text).toContain("not valid JSON");

      const off = yield* call(api, { method: "PUT", path, token, body: printJson({ other: 1 }) });
      expect(off.status).toBe(422);
      expect(off.text).toContain("doesn't match the schema");
      expect(yield* fs.exists(files.answer)).toBe(false);

      const answer = printJson({ status: "done" });
      const stored = yield* call(api, { method: "PUT", path, token, body: answer });
      expect(stored.status).toBe(204);
      expect(yield* fs.readFileString(files.answer)).toBe(answer);

      // The stop route then finds it, as the Stop hook found the agent's file.
      const stopped = yield* call(api, {
        path: routeOf(RUN, SESSION, "stop"),
        token,
        body: STOP_INPUT,
      });

      expect(stopped.text).toBe("");
      expect(yield* fs.readFileString(files.done)).toBe(printJson({ ok: true }));

      // Once done, the answer stands.
      const late = yield* call(api, {
        method: "PUT",
        path,
        token,
        body: printJson({ status: "late" }),
      });

      expect(late.status).toBe(409);
      expect(yield* fs.readFileString(files.answer)).toBe(answer);
    }),
  );
});

// What a bundled prompt or recipe tells an agent to run: each `chernabog …`
// line of a fenced shell block, as the command's name and its flags.
const toldToRun = (prompt: string) =>
  [...prompt.matchAll(/```(?:sh|bash|shell)?\n([\s\S]*?)```/g)].flatMap(([, block = ""]) =>
    block.split("\n").flatMap((line) => {
      const words = line.trim().split(/\s+/);

      if (words[0] !== "chernabog") {
        return [];
      }

      return [{ name: words[1] ?? "", flags: words.filter((word) => word.startsWith("--")) }];
    }),
  );

const bundledPrompts = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* path.fromFileUrl(new URL("../packages/recipes/prompts", import.meta.url));

  const recipes = yield* Effect.forEach(yield* fs.readDirectory(dir), (name) =>
    fs.readFileString(`${dir}/${name}`),
  );

  return [...Object.values(DefaultPrompts), ...recipes];
});

const DRAFT_ARGS = {
  draft: true,
  title: "feat: do the thing",
  body: "Adds the thing.",
};

describe("the session API's commands", () => {
  test("allow open-pr --draft, and nothing else", () => {
    expect(SESSION_COMMANDS).toEqual(["open-pr"]);
  });

  effect("cover every command a bundled prompt or recipe tells an agent to run", () =>
    Effect.gen(function* () {
      const told = (yield* bundledPrompts).flatMap(toldToRun);

      expect(told.length).toBeGreaterThan(0);

      for (const { name } of told) {
        expect([name, SESSION_COMMANDS.includes(name)]).toEqual([name, true]);
      }

      expect(
        told.filter(({ name }) => name === "open-pr").map(({ flags }) => flags.includes("--draft")),
      ).not.toContain(false);
    }),
  );

  effect("draft the pull request as chernabog open-pr --draft does, and print the question", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { api, root } = yield* hub;

      const { files, worktree } = yield* session(root, SESSION, {
        schema: Hybrid.finishedJsonSchema,
        withPerson: true,
      });

      const drafted = yield* call(api, {
        path: routeOf(RUN, SESSION, "commands/open-pr"),
        token: tokenFor(api, RUN, SESSION),
        body: printJson(DRAFT_ARGS),
      });

      expect(drafted.status).toBe(200);

      const draft = yield* Schema.decodeEffect(Draft)(yield* fs.readFileString(files.draft));
      const head = (yield* git(worktree, "rev-parse", "HEAD")).trim();

      expect(draft.head).toBe(head);
      expect(draft.answer).toBe(
        printJson({ title: DRAFT_ARGS.title, body: DRAFT_ARGS.body, summary: DRAFT_ARGS.title }),
      );

      expect(drafted.text).toContain("Drafted.");
      expect(drafted.text).toContain(printJson(questionFor(draft)));
      expect(yield* fs.exists(files.done)).toBe(false);
      expect(yield* fs.exists(files.answer)).toBe(false);
    }),
  );

  effect("refuse open-pr without --draft, which is the person's own", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { api, root } = yield* hub;

      const { files } = yield* session(root, SESSION, {
        schema: Hybrid.finishedJsonSchema,
        withPerson: true,
      });

      const without: ReadonlyArray<Json> = [
        { ...DRAFT_ARGS, draft: false },
        { title: "t", body: "b" },
        {},
      ];

      for (const args of without) {
        const refused = yield* call(api, {
          path: routeOf(RUN, SESSION, "commands/open-pr"),
          token: tokenFor(api, RUN, SESSION),
          body: printJson(args),
        });

        expect([args, refused.status]).toEqual([args, 422]);
      }

      expect(yield* fs.exists(files.draft)).toBe(false);
      expect(yield* fs.exists(files.done)).toBe(false);
      expect(yield* fs.exists(files.answer)).toBe(false);
    }),
  );

  effect("refuse a draft while the worktree has uncommitted changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { api, root } = yield* hub;

      const { files, worktree } = yield* session(root, SESSION, {
        schema: Hybrid.finishedJsonSchema,
        withPerson: true,
      });

      yield* fs.writeFileString(`${worktree}/wip.txt`, "wip\n");

      const refused = yield* call(api, {
        path: routeOf(RUN, SESSION, "commands/open-pr"),
        token: tokenFor(api, RUN, SESSION),
        body: printJson(DRAFT_ARGS),
      });

      expect(refused.status).toBe(422);
      expect(refused.text).toContain("wip.txt");
      expect(yield* fs.exists(files.draft)).toBe(false);
    }),
  );

  effect("refuse anything off the allowlist", () =>
    Effect.gen(function* () {
      const { api, root } = yield* hub;
      yield* session(root, SESSION, { schema: Hybrid.finishedJsonSchema, withPerson: true });
      const token = tokenFor(api, RUN, SESSION);

      for (const name of [
        "cancel",
        "start",
        "run",
        "enroll",
        "pause",
        "status",
        "open-pr-now",
        "PauseRepoCommand",
        "open-pr/../cancel",
      ]) {
        const refused = yield* call(api, {
          path: routeOf(RUN, SESSION, `commands/${name}`),
          token,
          body: "{}",
        });

        expect([name, refused.status]).toEqual([name, 404]);
      }

      const wrong = yield* call(api, {
        method: "GET",
        path: routeOf(RUN, SESSION, "commands/open-pr"),
        token,
      });

      expect(wrong.status).toBe(405);
    }),
  );

  effect("take only the session's own token, while its run is live", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { api, end, root } = yield* hub;

      const { files } = yield* session(root, SESSION, {
        schema: Hybrid.finishedJsonSchema,
        withPerson: true,
      });

      const path = routeOf(RUN, SESSION, "commands/open-pr");
      const body = printJson(DRAFT_ARGS);

      const without = yield* call(api, { path, body });
      expect(without.status).toBe(401);

      const other = yield* call(api, { path, body, token: tokenFor(api, RUN, OTHER_SESSION) });
      expect(other.status).toBe(401);

      yield* end(RUN);

      const ended = yield* call(api, { path, body, token: tokenFor(api, RUN, SESSION) });
      expect(ended.status).toBe(410);
      expect(yield* fs.exists(files.draft)).toBe(false);
    }),
  );
});

describe("the note a session with a person gets", () => {
  test("tells the agent to reach chernabog through the session API, with its token", () => {
    const files = sessionFiles("/home", SESSION);
    const prompt = withAnswerFile("Do it.", files, Option.some(Hybrid.finishedJsonSchema), true);

    expect(prompt).toContain("$CHERNABOG_SESSION_URL/commands/open-pr");
    expect(prompt).toContain("Authorization: Bearer $CHERNABOG_SESSION_TOKEN");
    expect(prompt).not.toContain(shellCommand(selfCommand()));
  });
});
