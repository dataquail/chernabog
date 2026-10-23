// `chernabog` with no arguments: a live view of the daemon. It never runs work
// itself; it reads the daemon's state over the socket, and attaches to agent
// sessions by handing the terminal to the agent's own interactive UI.

import {
  bold,
  createCliRenderer,
  cyan,
  dim,
  green,
  type KeyEvent,
  magenta,
  red,
  reverse,
  StyledText,
  type TextChunk,
  TextRenderable,
  yellow,
} from "@opentui/core";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

import { attachCommand, runSessions } from "../agents.ts";
import { Home } from "../config.ts";
import { runLogFile } from "../engine.ts";
import { daemonReload, daemonStatus, daemonTick } from "../interface/daemon/daemon.client.ts";
import { asSuffix, type Persona } from "../kernel/persona.value-object.ts";
import { pauseRepoUseCase } from "../modules/enrollment/use-cases/pause-repo.use-case.ts";
import { resumeRepoUseCase } from "../modules/enrollment/use-cases/resume-repo.use-case.ts";
import { setFlowScheduleUseCase } from "../modules/enrollment/use-cases/set-flow-schedule.use-case.ts";
import { setPersonaAccountUseCase } from "../modules/enrollment/use-cases/set-persona-account.use-case.ts";
import { setPersonaFlowUseCase } from "../modules/enrollment/use-cases/set-persona-flow.use-case.ts";
import { readMachineSetupUseCase } from "../modules/machine/use-cases/read-machine-setup.use-case.ts";
import { DEFAULT_GATE, loadMachineConfig } from "../repo-config.ts";
import { readUsageLogLine } from "../usage-gate.ts";
import { type Action, type Key, update } from "./update.ts";
import { flowKey, type Line, type Model, type Style, type UsageRow, view } from "./view.ts";

const plainChunk = (text: string): TextChunk => ({ __isChunk: true, text });

const STYLES: Readonly<Record<Style, (text: string) => TextChunk>> = {
  plain: plainChunk,
  bold,
  dim,
  green,
  red,
  yellow,
  cyan,
  magenta,
  selected: reverse,
};

const toStyled = (lines: ReadonlyArray<Line>) =>
  new StyledText(
    lines.flatMap((line, index) => [
      ...line.filter((part) => part.text.length > 0).map((part) => STYLES[part.style](part.text)),
      ...Arr.take([plainChunk("\n")], lines.length - 1 - index),
    ]),
  );

const USAGE_LOG = /^usage-(.+)\.jsonl$/;

// The latest usage reading per account, from the logs the usage gate writes.
export const readUsage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { root } = yield* Home;

  if (!(yield* fs.exists(root))) {
    return [];
  }

  const rows: Array<UsageRow> = [];

  for (const file of Arr.sort(yield* fs.readDirectory(root), Order.String)) {
    const account = Option.flatMap(Option.fromNullishOr(USAGE_LOG.exec(file)), (match) =>
      Option.fromUndefinedOr(match[1]),
    );

    if (Option.isNone(account)) {
      continue;
    }

    const last = Arr.last((yield* fs.readFileString(`${root}/${file}`)).trimEnd().split("\n"));
    const entry = Option.flatMap(last, readUsageLogLine);

    if (Option.isSome(entry)) {
      rows.push({
        account: account.value,
        fiveHour: entry.value.five_hour.utilization / 100,
        sevenDay: entry.value.seven_day.utilization / 100,
        launch: entry.value.launch,
        reason: entry.value.reason,
        at: entry.value.at,
      });
    }
  }

  return rows;
}).pipe(Effect.orElseSucceed((): ReadonlyArray<UsageRow> => []));

const LOG_LINES = 2000;

const readLog = (runId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* runLogFile(runId);

    if (!(yield* fs.exists(path))) {
      return [];
    }

    return (yield* fs.readFileString(path)).trimEnd().split("\n").slice(-LOG_LINES);
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

export const initialModel = (width: number, height: number, now: DateTime.Utc): Model => ({
  status: Option.none(),
  error: Option.none(),
  usage: [],
  thresholds: {
    fiveHourCeiling: DEFAULT_GATE.fiveHourCeiling,
    targetEndUsage: DEFAULT_GATE.targetEndUsage,
  },
  focus: "runs",
  flowIndex: 0,
  runIndex: 0,
  view: "main",
  settings: Option.none(),
  logRun: Option.none(),
  logLines: [],
  logScroll: 0,
  message: Option.none(),
  pendingFlows: {},
  width,
  height,
  now,
});

type Event =
  | { readonly kind: "key"; readonly key: Key }
  | { readonly kind: "resize" }
  | { readonly kind: "tick" };

const tickMessage = (
  repo: string,
  flow: string,
  started: ReadonlyArray<string>,
  skipped: Option.Option<string>,
) => {
  if (started.length > 0) {
    return `started ${started.join(", ")}`;
  }

  return `${repo}/${flow}: ${Option.getOrElse(skipped, () => "nothing to start")}`;
};

// Records the choice for the persona in machine config; the daemon restarts on it once idle.
const setFlowEnabled = (repo: string, flow: string, persona: Persona, enabled: boolean) =>
  Effect.gen(function* () {
    yield* setPersonaFlowUseCase(repo, persona, flow, enabled);
    yield* daemonReload.pipe(Effect.ignore);
  });

const toggleMessage = (repo: string, flow: string, persona: Persona, enabled: boolean) => {
  const name = `${repo}/${flow}${asSuffix(persona)}`;

  if (enabled) {
    return `turned ${name} on in machine config; the daemon picks it up when idle`;
  }

  return `turned ${name} off in machine config; the daemon picks it up when idle`;
};

// Overrides written to machine config; the daemon restarts on them once idle.
const scheduleMessage = (
  repo: string,
  flow: string,
  persona: Persona,
  schedule: Option.Option<string>,
) =>
  Option.match(schedule, {
    onNone: () =>
      `cleared ${repo}/${flow}${asSuffix(persona)}'s schedule, back to the team's; the daemon picks it up when idle`,
    onSome: (cron) =>
      `scheduled ${repo}/${flow}${asSuffix(persona)} at ${cron}; the daemon picks it up when idle`,
  });

const accountMessage = (
  repo: string,
  persona: Persona,
  role: Option.Option<string>,
  account: Option.Option<string>,
) => {
  const whose = `${repo}${asSuffix(persona)}${Option.match(role, { onNone: () => "", onSome: (named) => ` role ${named}` })}`;

  return Option.match(account, {
    onNone: () =>
      `cleared ${whose}'s account, back to the default; the daemon picks it up when idle`,
    onSome: (name) => `${whose} spends ${name}; the daemon picks it up when idle`,
  });
};

const pauseMessage = (repo: string, paused: boolean) => {
  if (paused) {
    return `paused ${repo}: no new runs start`;
  }

  return `resumed ${repo}`;
};

export const runTui = Effect.gen(function* () {
  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() => createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen" })),
    (opened) =>
      Effect.sync(() => {
        opened.destroy();
      }).pipe(Effect.andThen(Effect.promise(() => opened.closed))),
  );

  const screen = new TextRenderable(renderer, { content: "" });
  renderer.root.add(screen);

  const events = yield* Queue.unbounded<Event>();

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    Queue.offerUnsafe(events, {
      kind: "key",
      key: { name: key.name, ctrl: key.ctrl, sequence: key.sequence },
    });
  });
  renderer.on("resize", () => {
    Queue.offerUnsafe(events, { kind: "resize" });
  });

  let model = initialModel(renderer.terminalWidth, renderer.terminalHeight, yield* DateTime.now);
  const machine = yield* Effect.option(loadMachineConfig);

  if (Option.isSome(machine)) {
    model = { ...model, thresholds: machine.value.usageGate };
  }

  const render = Effect.gen(function* () {
    model = {
      ...model,
      width: renderer.terminalWidth,
      height: renderer.terminalHeight,
      now: yield* DateTime.now,
    };
    screen.content = toStyled(view(model));
  });

  const refresh = Effect.gen(function* () {
    const status = yield* Effect.result(daemonStatus);
    const usage = yield* readUsage;

    model = Result.match(status, {
      // A daemon that has restarted has picked up every flow turned on or off from here.
      onSuccess: (found): Model => {
        const sameDaemon = Option.exists(
          model.status,
          (previous) => previous.startedAt === found.startedAt && previous.pid === found.pid,
        );

        const pendingFlows = Option.getOrElse(
          Option.liftPredicate(model.pendingFlows, () => sameDaemon),
          () => ({}),
        );

        return { ...model, status: Option.some(found), error: Option.none(), usage, pendingFlows };
      },
      onFailure: (failure): Model => ({
        ...model,
        status: Option.none(),
        error: Option.some(`${failure.message}. Retrying…`),
        usage,
      }),
    });

    if (model.view === "log" && Option.isSome(model.logRun)) {
      model = { ...model, logLines: yield* readLog(model.logRun.value) };
    }

    yield* render;
  });

  const say = (message: string) =>
    Effect.gen(function* () {
      model = { ...model, message: Option.some(message) };
      yield* refresh;
    });

  const attach = (runId: string) =>
    Effect.gen(function* () {
      const session = Arr.last(yield* runSessions(runId));

      if (Option.isNone(session)) {
        return yield* say(`${runId} has opened no agent session yet`);
      }

      const { args, command, cwd, env } = yield* attachCommand(session.value);
      yield* Effect.promise(() => renderer.suspend());
      yield* Console.log(
        `\nAttaching to ${session.value.adapter} session ${session.value.sessionId} in ${cwd}. Exit the agent to come back.\n`,
      );

      const exited = yield* Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* ChildProcess.make(command, [...args], {
              cwd,
              env,
              extendEnv: false,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
              forceKillAfter: "5 seconds",
            });

            return yield* agent.exitCode;
          }),
        ),
      );

      yield* Effect.promise(() => renderer.resume());

      yield* say(
        Result.match(exited, {
          onSuccess: () => `back from ${session.value.adapter}`,
          onFailure: (error) => `could not start ${command}: ${error.message}`,
        }),
      );
    });

  const perform = (action: Action) =>
    Effect.gen(function* () {
      switch (action.kind) {
        case "quit":
        case "none":
          return yield* render;
        case "refresh":
          return yield* refresh;
        case "open-log":
          model = { ...model, logLines: yield* readLog(action.run) };

          return yield* render;
        case "attach":
          return yield* attach(action.run);
        case "trigger": {
          const result = yield* Effect.result(
            daemonTick({
              repo: action.repo,
              flow: action.flow,
              item: Option.none(),
              ...Option.match(action.persona, {
                onNone: () => ({}),
                onSome: (persona) => ({ persona }),
              }),
            }),
          );

          return yield* say(
            Result.match(result, {
              onSuccess: (tick) =>
                tickMessage(action.repo, action.flow, tick.started, tick.skipped),
              onFailure: (failure) => failure.message,
            }),
          );
        }

        case "toggle-flow": {
          const toggled = yield* Effect.result(
            setFlowEnabled(action.repo, action.flow, action.persona, action.enabled),
          );

          if (Result.isSuccess(toggled)) {
            model = {
              ...model,
              pendingFlows: {
                ...model.pendingFlows,
                [flowKey(action.repo, action.flow, action.persona)]: action.enabled,
              },
            };
          }

          return yield* say(
            Result.match(toggled, {
              onSuccess: () =>
                toggleMessage(action.repo, action.flow, action.persona, action.enabled),
              onFailure: (failure) => failure.message,
            }),
          );
        }

        case "set-schedule": {
          const written = yield* Effect.result(
            Effect.andThen(
              setFlowScheduleUseCase(action.repo, action.persona, action.flow, action.schedule),
              daemonReload.pipe(Effect.ignore),
            ),
          );

          return yield* say(
            Result.match(written, {
              onSuccess: () =>
                scheduleMessage(action.repo, action.flow, action.persona, action.schedule),
              onFailure: (failure) => failure.message,
            }),
          );
        }

        case "set-account": {
          const written = yield* Effect.result(
            Effect.andThen(
              Effect.flatMap(readMachineSetupUseCase(), (offered) =>
                setPersonaAccountUseCase(
                  action.repo,
                  action.persona,
                  action.role,
                  action.account,
                  offered,
                ),
              ),
              daemonReload.pipe(Effect.ignore),
            ),
          );

          return yield* say(
            Result.match(written, {
              onSuccess: () =>
                accountMessage(action.repo, action.persona, action.role, action.account),
              onFailure: (failure) => failure.message,
            }),
          );
        }

        case "pause": {
          let toggle = resumeRepoUseCase(action.repo);

          if (action.paused) {
            toggle = pauseRepoUseCase(action.repo);
          }

          const paused = yield* Effect.result(toggle);

          return yield* say(
            Result.match(paused, {
              onSuccess: () => pauseMessage(action.repo, action.paused),
              onFailure: (failure) => failure.message,
            }),
          );
        }
      }
    });

  yield* Effect.forkScoped(
    Effect.repeat(Queue.offer(events, { kind: "tick" }), Schedule.spaced("1 second")),
  );
  yield* refresh;

  for (;;) {
    const event = yield* Queue.take(events);

    if (event.kind === "tick") {
      yield* refresh;
      continue;
    }

    if (event.kind === "resize") {
      yield* render;
      continue;
    }

    const next = update(model, event.key);
    model = next.model;

    if (next.action.kind === "quit") {
      return;
    }

    yield* perform(next.action);
  }
}).pipe(Effect.scoped);
