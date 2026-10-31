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
import { FLOW_TURNED_OFF } from "../../../modules/enrollment/domain/enrolled-repo/team-flows.value-object.ts";
import { EnrollmentQueries } from "../../../modules/enrollment/enrollment.query-handlers.ts";
import { type RunMarkerView } from "../../../modules/runs/domain/run-marker/run-marker-view.value-object.ts";
import { type TrustCheck } from "../../../modules/trust/queries/check-trust.query.ts";
import { TrustQueries } from "../../../modules/trust/trust.query-handlers.ts";
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

// An item as people name it: #14 for issue-14, PR 8 for pr-8, any other key as is.
const itemName = (key: string) =>
  key.replace(/^issue-(\d+)$/, "#$1").replace(/^pr-(\d+)$/, "PR $1");

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
const argsText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

// A marker an ended run left: its release keeps failing, or a person must take it off.
const markerLine = (marker: RunMarkerView) => {
  const what = `  ${shortRunId(marker.runId)}  ${marker.name} ${argsText(marker.args)}`;
  const why = Option.getOrElse(marker.lastError, () => "");

  if (marker.status === "unreleasable") {
    return `${what}: can't be released (${why}); take it off by hand`;
  }

  if (marker.attempts === 0) {
    return `${what}: releasing`;
  }

  return `${what}: failed ${marker.attempts} time(s), last: ${why}; trying again`;
};

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
    const waiting = flow.waiting ?? [];

    // An event tick waiting to run is due now, whenever the rate cap lets it go.
    const next = Option.match(Option.fromUndefinedOr(flow.pending), {
      onNone: () => relative(flow.next, now),
      onSome: (pending) => `due now (${pending})`,
    });

    const last = Option.match(Option.fromUndefinedOr(flow.lastCause), {
      onNone: () => "",
      onSome: (cause) => `, last ${relative(flow.lastTick, now)} (${cause})`,
    });

    return `  ${name}: ${flow.schedule}, next ${next}${last}${when(elsewhere.length > 0, `; left for others: ${elsewhere.join(", ")}`)}${when(waiting.length > 0, `; waiting: ${waiting.join(", ")}`)}`;
  };

  return [
    `daemon ${status.pid}, up since ${upSince}${daemonState(status)}`,
    "",
    // A persona whose notifications can't be read, and the fix; its flows tick on cron.
    ...(status.notifications ?? []).flatMap((polling) =>
      Option.toArray(
        Option.map(
          polling.problem,
          (problem) =>
            `notifications${suffix(Option.fromUndefinedOr(polling.persona), " for ")}: ${problem} (ticking on cron meanwhile)`,
        ),
      ),
    ),
    ...status.repos.flatMap((repo) => [
      `${repo.name} (${repo.slug}): ${repoLine(repo)}${suffix(repo.launcher, ", launcher ")}${suffix(repo.message, " — ")}`,
      ...repo.flows.map(flowLine),
    ]),
    "",
    Option.match(Arr.head(status.active), {
      onNone: () => "nothing in flight",
      onSome: () => "in flight:",
    }),
    ...status.active.flatMap((run) => [
      `  ${shortRunId(run.id)}  ${runLabel(run)}  ${runLine(run)}${suffix(run.itemTitle, "  ")}`,
      // A check of its work item that keeps failing; the run carries on.
      ...(status.validity ?? [])
        .filter((check) => check.runId === run.id)
        .map(
          (check) =>
            `    stillValid failed ${check.failures} time(s) in a row: ${check.problem} (the run carries on)`,
        ),
      // Its leases, and one whose last renewal failed, which is at risk.
      ...(status.leases ?? [])
        .filter((lease) => lease.runId === run.id)
        .map(
          (lease) =>
            `    lease on ${lease.item}${suffix(lease.expiresAt, " until ")}${suffix(lease.renewedAt, ", renewed ")}${suffix(
              Option.map(lease.atRisk, (problem) => `at risk: ${problem}`),
              "; ",
            )}`,
        ),
    ]),
    ...Option.toArray(Option.map(Arr.head(status.markers ?? []), () => "\nnot yet released:")),
    ...(status.markers ?? []).map(markerLine),
    ...Option.toArray(Option.map(Arr.head(finished), () => "\nrecent:")),
    ...finished
      .slice(0, 8)
      .map(
        (run) =>
          `  ${run.status.padEnd(11)} ${shortRunId(run.id)}  ${runLabel(run)}  ${Option.getOrElse(run.summary, () => "")}`,
      ),
    ...Option.toArray(Option.map(Arr.head(status.holds ?? []), () => "\nheld:")),
    ...(status.holds ?? []).map(
      (hold) =>
        `  ${hold.repo}/${hold.flow}${suffix(
          Option.map(hold.persona, (login) => `@${login}`),
          "",
        )} ${itemName(hold.itemKey)}: ${hold.reason} (as of ${relative(Option.some(hold.at), now)})`,
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

    const enrollment = yield* EnrollmentQueries;
    const trust = yield* TrustQueries;
    const { repos } = yield* enrollment.ListEnrolledReposQuery({ name: Option.none() });

    const checked = yield* Effect.forEach(repos, (repo) =>
      trust
        .CheckTrustQuery({ repo: repo.repo, path: repo.path })
        .pipe(Effect.map((check) => ({ name: repo.name, check }))),
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
