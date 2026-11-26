// The Agent service: starts or resumes a coding agent's session in a worktree,
// headless, and returns its final structured answer. No flow depends on a
// specific agent; each adapter knows how to drive one CLI.

import {
  Agent,
  AgentError,
  CurrentActivity,
  HEADLESS,
  NO_SANDBOX,
  type RepoSettings,
  Run,
  RunLog,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import type { Persona } from "../../../../kernel/persona.value-object.ts";
import { RunId } from "../../../../kernel/run-id.id.ts";
import type { StandIns } from "../../../../kernel/stand-in.value-object.ts";
import { codexHomeOf } from "../../../../platform/agent-accounts.ts";
import { type Environment, HostEnvironment } from "../../../../platform/environment.ts";
import type { Exec } from "../../../../platform/exec.ts";
import { GitHubTokens } from "../../../../platform/github-auth.ts";
import { Home } from "../../../../platform/home.ts";
import { SessionApiAccess, sessionEndpoint } from "../../../../platform/session-api-access.ts";
import { SESSION_API_LOOPBACK } from "../../../../platform/session-token.ts";
import { type Adapter, type AdapterServices, agentEnvironment } from "./agents/adapter.ts";
import { commitsSince, headOf, recordAnswer, recordUnanswered } from "./agents/answers.ts";
import { claudeAdapter } from "./agents/claude.ts";
import { claudeEnvironment } from "./agents/claude-events.ts";
import { codexAdapter } from "./agents/codex.ts";
import { customAdapter } from "./agents/custom.ts";
import { opencodeAdapter } from "./agents/opencode.ts";
import { REHEARSAL, rehearsalAdapter } from "./agents/rehearsal.ts";
import { knownLaunch, sessionFiles } from "./agents/session-files.ts";
import {
  knownSession,
  recordRunSession,
  runSessions,
  type SessionRecord,
} from "./agents/sessions.ts";
import { recordingTokenUsage } from "./agents/token-usage.ts";
import { isInteractive, launcherFor } from "./launchers.ts";
import { sessionApiHostFor } from "./launchers/container.ts";
import { RunRecords } from "./run-records.ts";
import { sandboxRefusal, sandboxUnavailable } from "./sandboxes.ts";

export type AgentsConfig = Readonly<
  Record<
    string,
    {
      readonly args?: ReadonlyArray<string>;
      readonly start?: ReadonlyArray<string>;
      readonly resume?: ReadonlyArray<string>;
      readonly standIns?: StandIns;
      readonly dir?: string;
      readonly exclusive?: boolean;
    }
  >
>;

export const BUILT_IN_AGENTS: ReadonlyArray<string> = ["claude", "codex", "opencode", REHEARSAL];

// The rehearsal agent, when machine config (or a rehearsal) gives it stand-ins.
const rehearsalOf = (agents: AgentsConfig) =>
  Option.flatMap(Record.get(agents, REHEARSAL), (agent) =>
    Option.map(Option.fromUndefinedOr(agent.standIns), (standIns) => ({
      adapter: rehearsalAdapter({ standIns, dir: agent.dir ?? "." }),
      exclusive: agent.exclusive === true,
    })),
  );

export const adaptersFor = (agents: AgentsConfig): ReadonlyArray<Adapter> => {
  const rehearsal = rehearsalOf(agents);

  // An exclusive rehearsal answers every call, so no real agent is there to start.
  if (Option.exists(rehearsal, (found) => found.exclusive)) {
    return Option.toArray(
      Option.map(rehearsal, (found) => ({ ...found.adapter, exclusive: true })),
    );
  }

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
    ...Option.toArray(Option.map(rehearsal, (found) => found.adapter)),
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
            const exclusive = Arr.findFirst(adapters, (candidate) => candidate.exclusive === true);

            const name = Option.match(exclusive, {
              onNone: () => Option.getOrElse(request.adapter, () => settings.agent),
              onSome: (only) => only.name,
            });

            const found = Arr.findFirst(adapters, (candidate) => candidate.name === name);

            if (Option.isNone(found)) {
              return yield* new AgentError({
                message: `no agent adapter named ${name} (known: ${adapters.map((known) => known.name).join(", ")})`,
              });
            }

            // A rehearsal stands in for the person too.
            if (
              request.withPerson === true &&
              name !== REHEARSAL &&
              !(name === "claude" && isInteractive(settings.launcher))
            ) {
              return yield* new AgentError({
                message: `a session with a person needs claude under a launcher (orca, tmux or your own), but this one is ${name} with launcher ${settings.launcher.name}`,
              });
            }

            // A sandbox that can't start refuses the session; nothing falls
            // back to running the agent on the host (ADR 24, decision 2). A
            // rehearsal runs no agent, so it has nothing to sandbox.
            const sandbox = settings.sandbox ?? NO_SANDBOX;

            if (name !== REHEARSAL) {
              const refusal = yield* Option.match(
                sandboxRefusal(sandbox, {
                  adapter: name,
                  interactive: isInteractive(settings.launcher),
                  platform: host.platform,
                  host: host.variables,
                }),
                {
                  onNone: () => sandboxUnavailable(sandbox),
                  onSome: (said) => Effect.succeedSome(said),
                },
              );

              for (const said of Option.toArray(refusal)) {
                return yield* new AgentError({ message: `${name}: ${said}` });
              }

              // Its own config dir, where its transcripts are read from from the start.
              if (sandbox.name !== "none") {
                yield* (yield* FileSystem.FileSystem)
                  .makeDirectory(sessionFiles((yield* Home).root, request.sessionId).claude, {
                    recursive: true,
                  })
                  .pipe(Effect.mapError((error) => new AgentError({ message: error.message })));
              }
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

              // A spoke reports the session in its journal too, where its hub
              // finds it to close it (ADR 23, decision 5).
              for (const records of Option.toArray(yield* Effect.serviceOption(RunRecords))) {
                const transcripts = yield* Option.match(
                  Option.fromUndefinedOr(found.value.transcripts),
                  {
                    onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
                    onSome: (of) => of({ sessionId: request.sessionId, cwd: request.cwd, account }),
                  },
                );

                yield* records.openedSession(RunId.make(run.value.runId), {
                  adapter: name,
                  sessionId: request.sessionId,
                  launch: sessionFiles((yield* Home).root, request.sessionId).launch,
                  transcripts,
                });
              }
            }

            const env = {
              ...settings.env,
              ...(yield* tokens
                .env(persona)
                .pipe(Effect.mapError((error) => new AgentError({ message: error.message })))),
            };

            const activity = yield* CurrentActivity;
            const step = Option.orElse(Option.fromUndefinedOr(request.step), () => activity);

            const asked = Option.match(step, {
              onNone: () => request,
              onSome: (named) => ({ ...request, step: named }),
            });

            const before = yield* headOf(request.cwd);
            const log = yield* logOf;

            // The session's routes on the hub's session API, in a run whose hub handed out its key.
            const access = yield* Effect.serviceOption(SessionApiAccess);

            const sessionApi = Option.flatMap(run, (info) =>
              Option.flatMap(access, (given) =>
                sessionEndpoint(
                  given,
                  info.runId,
                  request.sessionId,
                  sessionApiHostFor(sandbox.name, SESSION_API_LOOPBACK),
                ),
              ),
            );

            const result = yield* found.value
              .run(asked, {
                account,
                host: host.variables,
                env,
                launcher: settings.launcher,
                sandbox,
                log,
                sessionApi,
              })
              .pipe(
                // What the call spent, however it ends, in a run.
                recordingTokenUsage(
                  found.value,
                  { sessionId: request.sessionId, cwd: request.cwd, account },
                  step,
                  log,
                ),
                // A rehearsal fails on a step it couldn't answer, whatever the flow does about it.
                Effect.tapError((error) =>
                  Option.match(
                    Option.filter(run, () => found.value.exclusive === true),
                    {
                      onNone: () => Effect.void,
                      onSome: (info) =>
                        recordUnanswered(
                          info.runId,
                          Option.getOrElse(step, () => "(outside any step)"),
                          error.message,
                        ),
                    },
                  ),
                ),
              );

            // What a replay stands in with: the answer, and the commits the step made.
            if (Option.isSome(run) && Option.isSome(step)) {
              yield* recordAnswer(run.value.runId, {
                step: step.value,
                adapter: name,
                answer: result.output,
                commits: yield* commitsSince(request.cwd, before),
              });
            }

            return result;
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
      sandbox: NO_SANDBOX,
      log: () => Effect.void,
      sessionApi: Option.none(),
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

// Why a run's session can't be opened in its launcher, for a person.
export class OpenRefused extends Schema.TaggedError<
  OpenRefused,
  { readonly brand: "OpenRefused" }
>()("OpenRefused", { message: Schema.String }) {}

// A run's latest session, brought up in the launcher it runs under, on this
// machine: the launcher, and the session.
export const openRunSession = (
  runId: string,
): Effect.Effect<
  { readonly launcher: string; readonly sessionId: string },
  OpenRefused,
  Home | FileSystem.FileSystem | Exec
> =>
  Effect.gen(function* () {
    const refuse = (message: string) => Effect.fail(new OpenRefused({ message }));
    const session = Arr.last(yield* runSessions(runId));

    if (Option.isNone(session)) {
      return yield* refuse(`${runId} has opened no agent session yet`);
    }

    const { sessionId } = session.value;
    const launch = yield* knownLaunch(sessionFiles((yield* Home).root, sessionId));
    const launcher = Option.flatMap(launch, (found) => launcherFor(found.launcher));

    if (Option.isNone(launch) || Option.isNone(launcher)) {
      return yield* refuse(
        "its session runs headless, with no launcher to open it in: copy the attach command and run it in a terminal",
      );
    }

    const { name } = launcher.value;
    const opening = launcher.value.open;

    if (Option.isNone(opening)) {
      return yield* refuse(
        `${name} can't open a session itself: copy the attach command and run it in a terminal`,
      );
    }

    const alive = yield* launcher.value
      .alive(launch.value.handle)
      .pipe(Effect.orElseSucceed(() => false));

    if (!alive) {
      return yield* refuse(
        `its session in ${name} has ended: copy the attach command to resume it in a terminal`,
      );
    }

    yield* opening
      .value(launch.value.handle)
      .pipe(Effect.catch((error) => refuse(`${name} couldn't open it: ${error.message}`)));

    return { launcher: name, sessionId };
  });

export { runSessions, type SessionRecord } from "./agents/sessions.ts";
