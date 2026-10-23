// The Agent service: starts or resumes a coding agent's session in a worktree,
// headless, and returns its final structured answer. No flow depends on a
// specific agent; each adapter knows how to drive one CLI.

import { Agent, AgentError, HEADLESS, type RepoSettings, Run, RunLog } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import type { Persona } from "../../../../kernel/persona.value-object.ts";
import { codexHomeOf } from "../../../../platform/agent-accounts.ts";
import { type Environment, HostEnvironment } from "../../../../platform/environment.ts";
import { GitHubTokens } from "../../../../platform/github-auth.ts";
import { Home } from "../../../../platform/home.ts";
import { type Adapter, type AdapterServices, agentEnvironment } from "./agents/adapter.ts";
import { claudeAdapter } from "./agents/claude.ts";
import { claudeEnvironment } from "./agents/claude-events.ts";
import { codexAdapter } from "./agents/codex.ts";
import { customAdapter } from "./agents/custom.ts";
import { opencodeAdapter } from "./agents/opencode.ts";
import { knownLaunch, sessionFiles } from "./agents/session-files.ts";
import { knownSession, recordRunSession, type SessionRecord } from "./agents/sessions.ts";
import { isInteractive, launcherFor } from "./launchers.ts";

export type AgentsConfig = Readonly<
  Record<
    string,
    {
      readonly args?: ReadonlyArray<string>;
      readonly start?: ReadonlyArray<string>;
      readonly resume?: ReadonlyArray<string>;
    }
  >
>;

export const BUILT_IN_AGENTS: ReadonlyArray<string> = ["claude", "codex", "opencode"];

export const adaptersFor = (agents: AgentsConfig): ReadonlyArray<Adapter> => {
  const custom = Object.entries(agents).flatMap(([name, agent]) => {
    if (BUILT_IN_AGENTS.includes(name)) {
      return [];
    }

    return Option.toArray(
      Option.map(Option.fromUndefinedOr(agent.start), (start) =>
        customAdapter(name, { start, resume: Option.fromUndefinedOr(agent.resume) }),
      ),
    );
  });

  return [
    claudeAdapter,
    codexAdapter,
    opencodeAdapter(
      Option.getOrElse(
        Option.flatMap(Record.get(agents, "opencode"), (agent) =>
          Option.fromUndefinedOr(agent.args),
        ),
        () => [],
      ),
    ),
    ...custom,
  ];
};

const logOf = Effect.serviceOption(RunLog).pipe(
  Effect.map(
    Option.match({
      onNone: () => (line: string) => Console.error(line),
      onSome: (runLog) => runLog.log,
    }),
  ),
);

// The run's own log comes from the run that calls, so one Agent serves every
// run of a repo as one persona. The agent acts as that persona too: its gh and
// git get the persona's token.
export const AgentLive = (
  settings: RepoSettings,
  adapters: ReadonlyArray<Adapter>,
  persona: Persona,
) =>
  Layer.effect(
    Agent,
    Effect.gen(function* () {
      const services = yield* Effect.context<AdapterServices>();
      const host = yield* HostEnvironment;
      const tokens = yield* GitHubTokens;

      return Agent.of({
        adapters: adapters.map((adapter) => adapter.name),
        run: (request) =>
          Effect.gen(function* () {
            const name = Option.getOrElse(request.adapter, () => settings.agent);
            const found = Arr.findFirst(adapters, (candidate) => candidate.name === name);

            if (Option.isNone(found)) {
              return yield* new AgentError({
                message: `no agent adapter named ${name} (known: ${adapters.map((known) => known.name).join(", ")})`,
              });
            }

            if (
              request.withPerson === true &&
              !(name === "claude" && isInteractive(settings.launcher))
            ) {
              return yield* new AgentError({
                message: `a session with a person needs claude under a launcher (orca, tmux or your own), but this one is ${name} with launcher ${settings.launcher.name}`,
              });
            }

            // Each agent runs under its own account: a Codex reviewer on a Claude repo spends the Codex account.
            const account = Option.getOrElse(
              Record.get(settings.agentAccounts, name),
              () => settings.account,
            );

            const run = yield* Effect.serviceOption(Run);

            if (Option.isSome(run)) {
              yield* recordRunSession(
                run.value.runId,
                name,
                request.sessionId,
                request.cwd,
                account,
              );
            }

            const env = {
              ...settings.env,
              ...(yield* tokens
                .env(persona)
                .pipe(Effect.mapError((error) => new AgentError({ message: error.message })))),
            };

            return yield* found.value.run(request, {
              account,
              host: host.variables,
              env,
              launcher: settings.launcher,
              log: yield* logOf,
            });
          }).pipe(Effect.provide(services)),
      });
    }),
  );

export type AttachCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Environment;
};

// What brings up an interactive session that is still running: the Orca tab, `tmux attach`.
export const liveAttach = (record: SessionRecord, host: Environment) =>
  Effect.gen(function* () {
    const launch = yield* knownLaunch(sessionFiles((yield* Home).root, record.sessionId));

    if (Option.isNone(launch)) {
      return Option.none<AttachCommand>();
    }

    const launcher = launcherFor(launch.value.launcher);

    if (Option.isNone(launcher)) {
      return Option.none<AttachCommand>();
    }

    const alive = yield* launcher.value
      .alive(launch.value.handle)
      .pipe(Effect.orElseSucceed(() => false));

    return Option.map(
      Option.filter(launcher.value.attach(launch.value.handle), () => alive),
      (attach): AttachCommand => ({
        command: attach.command,
        args: attach.args,
        cwd: record.cwd,
        env: host,
      }),
    );
  });

// The command that opens a session: the live one where its launcher has it, or else the agent's own interactive UI, in its worktree.
export const attachCommand = (record: SessionRecord) =>
  Effect.gen(function* () {
    const host = (yield* HostEnvironment).variables;

    const context = {
      account: record.account,
      host,
      env: {},
      launcher: HEADLESS,
      log: () => Effect.void,
    };

    const session = Option.getOrElse(
      yield* knownSession(record.adapter, record.sessionId),
      () => record.sessionId,
    );

    if (record.adapter === "claude") {
      const live = yield* liveAttach(record, host);

      if (Option.isSome(live)) {
        return live.value;
      }

      return {
        command: "claude",
        args: ["--resume", record.sessionId],
        cwd: record.cwd,
        env: claudeEnvironment(context),
      } satisfies AttachCommand;
    }

    if (record.adapter === "codex") {
      const env = agentEnvironment(
        context,
        { CODEX_HOME: codexHomeOf(record.account, (yield* Home).user) },
        ["CLAUDE_CONFIG_DIR"],
      );

      return {
        command: "codex",
        args: ["resume", session],
        cwd: record.cwd,
        env,
      } satisfies AttachCommand;
    }

    if (record.adapter === "opencode") {
      return {
        command: "opencode",
        args: ["--session", session],
        cwd: record.cwd,
        env: host,
      } satisfies AttachCommand;
    }

    return {
      command: Option.getOrElse(Record.get(host, "SHELL"), () => "sh"),
      args: [],
      cwd: record.cwd,
      env: host,
    } satisfies AttachCommand;
  });

export { runSessions, type SessionRecord } from "./agents/sessions.ts";
