// `chernabog progress`: the items' phase records (ADR 21). `progress
// backfill` writes a record for every open item that needs one and holds
// none, inferred from GitHub once (the repo's SDK's Backfill; the table is in
// docs/run-progress/audit.md, "Backfill"), so the sources' no-record paths
// can go. It prints what it would write; `--write` writes it.

import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import {
  type BackfillFinding,
  backfillProgress,
  type BackfillResult,
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

// What the command prints of what backfill found, and did.
export const reportOf = (result: BackfillResult, wrote: boolean) => {
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

export const progressCommand = <R>(config: ProgressConfigAccess<R>) =>
  Command.make("progress", {}, () => Effect.void).pipe(
    Command.withDescription("The phase records that hold each item's progress"),
    Command.withSubcommands([backfillCommand(config)]),
  );
