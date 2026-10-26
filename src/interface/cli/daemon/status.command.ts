import * as Arr from "effect/Array";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { asSuffix } from "../../../kernel/persona.value-object.ts";
import { RepoSlug } from "../../../kernel/repo-slug.id.ts";
import { runLabel, shortRunId } from "../../../kernel/run-id.id.ts";
import { FLOW_TURNED_OFF } from "../../../modules/enrollment/use-cases/enrolled-repos.result.ts";
import { listEnrolledReposUseCase } from "../../../modules/enrollment/use-cases/list-enrolled-repos.use-case.ts";
import { checkTrustUseCase } from "../../../modules/trust/use-cases/check-trust.use-case.ts";
import { type TrustCheck } from "../../../modules/trust/use-cases/trust-check.result.ts";
import { daemonStatus } from "../../daemon/daemon.client.ts";
import { DaemonStatus } from "../../daemon/daemon.protocol.ts";
import { printJson, printLines } from "../cli.output.ts";
import { jsonFlag } from "../output.arguments.ts";

const MINUTE_MS = 60_000;

const relative = (iso: Option.Option<string>, now: DateTime.Utc) =>
  Option.match(
    Option.flatMap(iso, (text) => DateTime.make(text)),
    {
      onNone: () => "never",
      onSome: (at) => {
        const minutes = Math.round(
          (DateTime.toEpochMillis(at) - DateTime.toEpochMillis(now)) / MINUTE_MS,
        );

        if (Math.abs(minutes) < 1) {
          return "now";
        }

        if (minutes > 0) {
          return `in ${minutes}m`;
        }

        return `${-minutes}m ago`;
      },
    },
  );

const suffix = (value: Option.Option<string>, prefix: string) =>
  Option.match(value, { onNone: () => "", onSome: (text) => `${prefix}${text}` });

const when = (condition: boolean, text: string) =>
  Option.getOrElse(
    Option.liftPredicate(text, () => condition),
    () => "",
  );

const repoLine = (repo: DaemonStatus["repos"][number]) => {
  if (repo.paused) {
    return "paused";
  }

  if (!repo.enabled) {
    return "disabled";
  }

  return repo.status;
};

// What the daemon is waiting to do, if anything.
const daemonState = (status: DaemonStatus) => {
  if (status.draining === true) {
    const executing = status.active.filter((run) => !run.parked).length;

    return `, draining: chernabog was upgraded, so it starts no new runs and restarts on the new version once ${executing} executing run${when(executing !== 1, "s")} finish${when(executing === 1, "es")}`;
  }

  return when(status.reloadPending, ", restarting on new config when idle");
};

const runLine = (run: DaemonStatus["active"][number]) => {
  if (run.parked) {
    return "waiting";
  }

  return Option.getOrElse(run.currentStep, () => "starting");
};

// What the daemon is doing, for a person.
export const describeStatus = (status: DaemonStatus, now: DateTime.Utc) => {
  const finished = status.recent.filter((run) => run.status !== "running");

  const upSince = Option.match(DateTime.make(status.startedAt), {
    onNone: () => status.startedAt,
    onSome: (at) => DateTime.formatLocal(at, { dateStyle: "short", timeStyle: "medium" }),
  });

  const flowLine = (flow: DaemonStatus["repos"][number]["flows"][number]) => {
    const name = `${flow.name}${asSuffix(Option.fromUndefinedOr(flow.persona))}${suffix(Option.fromUndefinedOr(flow.source), " · ")}`;

    if (!flow.enabled) {
      return `  ${name}: off${suffix(
        Option.filter(
          Option.fromUndefinedOr(flow.offReason),
          (reason) => reason !== FLOW_TURNED_OFF,
        ),
        ", ",
      )}`;
    }

    // A manual flow has no next tick: it runs when a person names its work.
    if (flow.manual === true) {
      return `  ${name}: ${flow.schedule}`;
    }

    const elsewhere = flow.assignedElsewhere ?? [];

    return `  ${name}: ${flow.schedule}, next ${relative(flow.next, now)}${when(elsewhere.length > 0, `; assigned elsewhere: ${elsewhere.join(", ")}`)}`;
  };

  return [
    `daemon ${status.pid}, up since ${upSince}${daemonState(status)}`,
    "",
    ...status.repos.flatMap((repo) => [
      `${repo.name} (${repo.slug}): ${repoLine(repo)}${suffix(repo.launcher, ", launcher ")}${suffix(repo.message, " — ")}`,
      ...repo.flows.map(flowLine),
    ]),
    "",
    Option.match(Arr.head(status.active), {
      onNone: () => "nothing in flight",
      onSome: () => "in flight:",
    }),
    ...status.active.map(
      (run) =>
        `  ${shortRunId(run.id)}  ${runLabel(run)}  ${runLine(run)}${suffix(run.itemTitle, "  ")}`,
    ),
    ...Option.toArray(Option.map(Arr.head(finished), () => "\nrecent:")),
    ...finished
      .slice(0, 8)
      .map(
        (run) =>
          `  ${run.status.padEnd(11)} ${shortRunId(run.id)}  ${runLabel(run)}  ${Option.getOrElse(run.summary, () => "")}`,
      ),
    ...Option.toArray(Option.map(Arr.head(status.skips), () => "\nrecent skips:")),
    ...status.skips.slice(0, 5).map(
      (skip) =>
        `  ${skip.repo}/${skip.flow}${suffix(
          Option.map(skip.persona, (login) => `@${login}`),
          "",
        )}${suffix(skip.itemKey, " ")}: ${skip.reason} (${relative(Option.some(skip.at), now)})`,
    ),
  ];
};

const trustLine = (check: TrustCheck) => {
  if (Option.isNone(check.tree)) {
    return "no .chernabog/ on its base branch";
  }

  if (check.trusted) {
    return "trusted";
  }

  return "not trusted";
};

// With no daemon to ask: why, and whether each repo's .chernabog/ is trusted.
const OfflineStatus = Schema.Struct({
  running: Schema.Literal(false),
  unavailable: Schema.String,
  repos: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      repo: RepoSlug,
      tree: Schema.OptionFromNullOr(Schema.String),
      trusted: Schema.Boolean,
    }),
  ),
});

const offline = (unavailable: string, json: boolean) =>
  Effect.gen(function* () {
    if (!json) {
      yield* Console.log(unavailable);
    }

    const { repos } = yield* listEnrolledReposUseCase(Option.none());

    const checked = yield* Effect.forEach(repos, (repo) =>
      checkTrustUseCase(repo).pipe(Effect.map((check) => ({ name: repo.name, check }))),
    );

    if (json) {
      return yield* printJson(OfflineStatus, {
        running: false,
        unavailable,
        repos: checked.map(({ check, name }) => ({
          name,
          repo: check.repo,
          tree: check.tree,
          trusted: check.trusted,
        })),
      });
    }

    yield* printLines(
      checked.map(({ check, name }) => `${name} (${check.repo}): ${trustLine(check)}`),
    );
  });

// What the daemon is doing; when it isn't running, whether each repo is trusted.
export const showStatus = (json: boolean) =>
  Effect.gen(function* () {
    const live = yield* Effect.result(daemonStatus);

    if (Result.isFailure(live)) {
      return yield* offline(live.failure.message, json);
    }

    if (json) {
      return yield* printJson(DaemonStatus, live.success);
    }

    yield* printLines(describeStatus(live.success, yield* DateTime.now));
  });

export const statusCommand = Command.make("status", { json: jsonFlag }, ({ json }) =>
  showStatus(json),
).pipe(
  Command.withDescription(
    "What the daemon is doing: repos, schedules, runs in flight, recent runs and skips",
  ),
);
