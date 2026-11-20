// `chernabog progress`: the items' phase records (ADR 21). `progress
// backfill` writes a record for every open item that needs one and holds
// none, inferred from GitHub once (the repo's SDK's Backfill; the table is in
// docs/run-progress/audit.md, "Backfill"), so the sources' no-record paths
// can go. It prints what it would write; `--write` writes it. `progress
// anomalies` lists every record a source holds its item for, a writer or a
// transition the catalogue doesn't know (ADR 21, decision 5);
// `--acknowledge` records each one's phase again, so the sources act on it.

import * as Arr from "effect/Array";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import {
  type AnomaliesResult,
  type Anomaly,
  type BackfillFinding,
  backfillProgress,
  type BackfillResult,
  progressAnomalies,
} from "../../modules/runs/runs.platform.ts";
import { type ConfigError } from "../../platform/config-error.ts";
import { repoFlag } from "./repo.arguments.ts";

type BackfillOptions = Parameters<typeof backfillProgress>[0];

// How the command reaches the machine config and the enrolled repo, which
// the CLI's root provides.
export type ProgressConfigAccess<R> = {
  readonly enrolled: (
    repo: string,
  ) => Effect.Effect<Pick<BackfillOptions, "machine" | "enrolled">, ConfigError, R>;
};

const describeFinding = (finding: BackfillFinding) => {
  if (finding.kind === "person") {
    return `for a person: ${finding.item}: ${finding.why}`;
  }

  return `${finding.item}: ${finding.phase} (${finding.why})`;
};

// A repo that lists no personas: in its .chernabog/config.yaml: the ledger
// checks writers against them, and backfill reads its logins from them alone.
const noPersonas = (repo: string, consequence: string) =>
  `warning: ${repo}'s .chernabog/config.yaml lists no personas:, so ${consequence}. List the logins its flows run as under personas: (in the checkout, with --from-checkout) and run it again.`;

const personasWarning = (
  result: { readonly repo: string; readonly personas: ReadonlyArray<string> },
  consequence: string,
) =>
  Arr.match(result.personas, {
    onEmpty: () => [noPersonas(result.repo, consequence)],
    onNonEmpty: () => [],
  });

const backfillLines = (result: BackfillResult, wrote: boolean) => {
  const toWrite = result.findings.filter((finding) => finding.kind === "write");
  const toPerson = result.findings.filter((finding) => finding.kind === "person");

  const lines = toWrite.map((finding) => {
    if (!wrote) {
      return `would write ${describeFinding(finding)}`;
    }

    if (result.lost.includes(finding.item)) {
      return `left ${finding.item}: a run recorded it after the survey read none`;
    }

    return `wrote ${describeFinding(finding)}`;
  });

  const said = [...lines, ...toPerson.map(describeFinding)];

  if (said.length === 0) {
    return [`${result.repo}: every open item that needs a record has one`];
  }

  if (!wrote && toWrite.length > 0) {
    return [...said, "Nothing is written: run it again with --write to write these."];
  }

  return said;
};

// What the command prints of what backfill found, and did.
export const reportOf = (result: BackfillResult, wrote: boolean) => [
  ...personasWarning(
    result,
    "backfill misses a pull request that only a persona's review marks as automated, and every epic status comment",
  ),
  ...backfillLines(result, wrote),
];

const backfillCommand = <R>(config: ProgressConfigAccess<R>) =>
  Command.make(
    "backfill",
    {
      repo: repoFlag,
      write: Flag.Boolean("write").pipe(
        Flag.withDescription("Write the records; without it, print what it would write"),
        Flag.withDefault(false),
      ),
      fromCheckout: Flag.Boolean("from-checkout").pipe(
        Flag.withDescription(
          "Read the working copy's .chernabog/, rather than the default branch's",
        ),
        Flag.withDefault(false),
      ),
    },
    (options) =>
      Effect.gen(function* () {
        const { enrolled, machine } = yield* config.enrolled(options.repo);

        const result = yield* backfillProgress({
          machine,
          enrolled,
          fromCheckout: options.fromCheckout,
          write: options.write,
        });

        yield* Effect.forEach(reportOf(result, options.write), (line) => Console.log(line), {
          discard: true,
        });
      }).pipe(Effect.scoped),
  ).pipe(
    Command.withDescription(
      "Write a phase record, inferred from GitHub, for each open item that needs one and has none",
    ),
  );

const describeAnomaly = (anomaly: Anomaly) =>
  `${anomaly.item}: record ${anomaly.version.slice(0, 7)} (${anomaly.from ?? "none"} -> ${anomaly.phase}, by ${anomaly.by}): ${anomaly.why}`;

const anomalyLines = (result: AnomaliesResult, acknowledged: boolean) => {
  if (result.anomalies.length === 0) {
    return [`${result.repo}: every record passes the check`];
  }

  const lines = result.anomalies.map((anomaly) => {
    if (!acknowledged) {
      return describeAnomaly(anomaly);
    }

    if (result.moved.includes(anomaly.item)) {
      return `left ${anomaly.item}: its record moved after the survey read it`;
    }

    return `acknowledged ${describeAnomaly(anomaly)}`;
  });

  if (!acknowledged) {
    return [
      ...lines,
      "Each one's item is held until its record is fixed: record the phase again as a persona, or run it again with --acknowledge to record each one's phase again as it is.",
    ];
  }

  return lines;
};

// What the command prints of the anomalies it found, and acknowledged.
export const anomaliesReportOf = (result: AnomaliesResult, acknowledged: boolean) => [
  ...personasWarning(
    result,
    "every record a persona wrote has an unknown writer, and is an anomaly",
  ),
  ...anomalyLines(result, acknowledged),
];

const anomaliesCommand = <R>(config: ProgressConfigAccess<R>) =>
  Command.make(
    "anomalies",
    {
      repo: repoFlag,
      acknowledge: Flag.Boolean("acknowledge").pipe(
        Flag.withDescription(
          "Record each anomaly's phase again, as it is, so the sources act on it; without it, list them",
        ),
        Flag.withDefault(false),
      ),
      fromCheckout: Flag.Boolean("from-checkout").pipe(
        Flag.withDescription(
          "Read the working copy's .chernabog/, rather than the default branch's",
        ),
        Flag.withDefault(false),
      ),
    },
    (options) =>
      Effect.gen(function* () {
        const { enrolled, machine } = yield* config.enrolled(options.repo);

        const result = yield* progressAnomalies({
          machine,
          enrolled,
          fromCheckout: options.fromCheckout,
          acknowledge: options.acknowledge,
        });

        yield* Effect.forEach(
          anomaliesReportOf(result, options.acknowledge),
          (line) => Console.log(line),
          { discard: true },
        );
      }).pipe(Effect.scoped),
  ).pipe(
    Command.withDescription(
      "List the phase records a source won't act on, an unknown writer's or an undeclared transition's, and acknowledge them",
    ),
  );

export const progressCommand = <R>(config: ProgressConfigAccess<R>) =>
  Command.make("progress", {}, () => Effect.void).pipe(
    Command.withDescription("The phase records that hold each item's progress"),
    Command.withSubcommands([backfillCommand(config), anomaliesCommand(config)]),
  );
