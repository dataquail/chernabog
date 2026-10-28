import { Agent, CurrentActivity, Run } from "@chernabog/core";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { effectAtHomeWith } from "../../../../../../test/effect-test.ts";
import { settings } from "../../../../../../test/sdk-fakes.ts";
import { Exec } from "../../../../../platform/exec.ts";
import { GitHubTokens } from "../../../../../platform/github-auth.ts";
import { adaptersFor, AgentLive, type AgentsConfig } from "../agents.ts";
import { runAnswers } from "./answers.ts";

const effect = effectAtHomeWith(Layer.mergeAll(GitHubTokens.fixed("token-implicit"), Exec.layer));

const outcome = { type: "object", properties: { status: { type: "string" } } };

const ask = (step: string, cwd: string, adapter: Option.Option<string> = Option.none()) =>
  Agent.use((agent) =>
    agent.run({
      cwd,
      prompt: "implement the issue",
      sessionId: `session-${step}`,
      resumePrompt: Option.none(),
      outputSchema: Option.some(outcome),
      adapter,
    }),
  ).pipe(Effect.provideService(CurrentActivity, Option.some(step)));

const inRun = Layer.succeed(
  Run,
  Run.of({
    flow: "implement",
    runId: "run-1",
    executionId: "x",
    item: { key: "issue-3", data: {} },
  }),
);

// Asks the Agent service of a repo whose agents are `agents`, in a run.
const askWith = <A, E>(agents: AgentsConfig, asking: Effect.Effect<A, E, Agent>) =>
  Effect.gen(function* () {
    const agent = yield* Layer.build(
      Layer.mergeAll(
        AgentLive({ ...settings, agent: "claude" }, adaptersFor(agents), Option.none()),
        inRun,
      ),
    );

    return yield* Effect.provideContext(asking, agent);
  });

// A git checkout with one commit, as a worktree is.
const checkout = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "rehearsal-worktree-" });
  const exec = yield* Exec;

  for (const args of [
    ["init", "-q", "-b", "main"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"],
  ]) {
    yield* exec.run("git", args, { cwd: dir });
  }

  return dir;
});

const GIT_ID =
  "GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t";

describe("the rehearsal agent", () => {
  effect("a script stands in, in the worktree, and its commits and answer are recorded", () =>
    Effect.gen(function* () {
      const cwd = yield* checkout;

      const agents: AgentsConfig = {
        rehearsal: {
          standIns: {
            implement: {
              script: `echo work > done.txt && git add done.txt && env ${GIT_ID} git commit -q -m "Do the work" && echo "step $CHERNABOG_STEP" && echo '{"status":"done"}'`,
            },
          },
          dir: "/stand-ins",
        },
      };

      const result = yield* askWith(agents, ask("implement", cwd, Option.some("rehearsal")));

      expect(result.output).toEqual({ status: "done" });

      expect(yield* runAnswers("run-1")).toEqual(
        Option.some([
          expect.objectContaining({
            step: "implement",
            adapter: "rehearsal",
            answer: { status: "done" },
            commits: ["Do the work"],
          }),
        ]),
      );
    }),
  );

  effect("an exclusive rehearsal answers every call, even one for another adapter", () =>
    Effect.gen(function* () {
      const cwd = yield* checkout;

      const agents: AgentsConfig = {
        rehearsal: {
          standIns: { "fix-ci-*": { fixture: { status: "fixed" }, commits: ["Fix CI"] } },
          exclusive: true,
        },
      };

      const result = yield* askWith(agents, ask("fix-ci-2", cwd, Option.some("codex")));

      expect(result.output).toEqual({ status: "fixed" });

      const log = yield* Exec.use((exec) => exec.run("git", ["log", "--format=%s", "-1"], { cwd }));

      expect(log.stdout.trim()).toBe("Fix CI");
    }),
  );

  effect("a step with no stand-in fails, naming the step", () =>
    Effect.gen(function* () {
      const cwd = yield* checkout;
      const agents: AgentsConfig = { rehearsal: { standIns: {}, exclusive: true } };

      const failure = yield* Effect.flip(askWith(agents, ask("review-1", cwd)));

      expect(failure.message).toContain("no stand-in for step review-1");
      expect(failure.message).toContain("review-*");
    }),
  );

  effect("an answer is the agent's, unchecked, for the step's own block to decode", () =>
    Effect.gen(function* () {
      const cwd = yield* checkout;

      const agents: AgentsConfig = {
        rehearsal: {
          standIns: { implement: { script: "echo 'not json at all'" } },
          exclusive: true,
        },
      };

      const result = yield* askWith(agents, ask("implement", cwd));
      expect(result.output).toBe("not json at all\n");
    }),
  );
});
