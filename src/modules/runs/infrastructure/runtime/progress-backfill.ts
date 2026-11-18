// `chernabog progress backfill` (ADR 21, consequences): the repo's own SDK's
// Backfill, run as the repo's first persona, over what every persona's login
// says is the repo's own. It surveys the open items that need a record and
// hold none; with `write`, it writes what it found, each from no record, so
// one a run recorded since keeps the run's. The binary never imports the SDK
// (ADR 4): it loads the repo's, as `ci plan` loads its Events.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { IMPLICIT } from "../../../../kernel/persona.value-object.ts";
import { ConfigError } from "../../../../platform/config-error.ts";
import { loadRepoBackfill } from "../../../../platform/flow-loader.ts";
import { viewerLoginAs } from "../../../../platform/github-api.ts";
import { defaultPersona } from "./engine.ts";
import { buildPersonaContexts, openRepo, servicesFrom } from "./repo-runtime.ts";

type MachineConfig = Parameters<typeof openRepo>[0];

type EnrolledRepo = Parameters<typeof openRepo>[1];

export type BackfillOptions = {
  readonly machine: MachineConfig;
  readonly enrolled: EnrolledRepo;
  // The working copy's .chernabog/, rather than the default branch's.
  readonly fromCheckout: boolean;
  // Write what the survey found; without it, only survey.
  readonly write: boolean;
};

// One finding of the SDK's survey: a phase to write, or an item for a person.
const BackfillFinding = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("write"),
    item: Schema.String,
    phase: Schema.String,
    data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    why: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("person"), item: Schema.String, why: Schema.String }),
]);

export type BackfillFinding = typeof BackfillFinding.Type;

// What writing one finding did: written, or left for a record a run wrote first.
const BackfillWritten = Schema.Struct({
  finding: Schema.Struct({ item: Schema.String }),
  written: Schema.Boolean,
});

export type BackfillResult = {
  readonly repo: string;
  // What the survey found to write, and what it leaves for a person.
  readonly findings: ReadonlyArray<BackfillFinding>;
  // With `write`: the items written, and those a run recorded first.
  readonly written: ReadonlyArray<string>;
  readonly lost: ReadonlyArray<string>;
};

const unreadable = (what: string) => (issue: { readonly message: string }) =>
  new ConfigError({
    message: `the repo's @chernabog/sdk gave ${what} this can't read: ${issue.message}`,
  });

export const backfillProgress = (options: BackfillOptions) =>
  Effect.gen(function* () {
    const { repo } = yield* openRepo(options.machine, options.enrolled, options.fromCheckout);
    const backfill = yield* loadRepoBackfill(repo.settings.configDir);

    if (Option.isNone(backfill)) {
      return yield* new ConfigError({
        message: `${repo.settings.name}'s @chernabog/sdk is from before progress backfill; chernabog recipes upgrade moves it on`,
      });
    }

    const servicesFor = servicesFrom(yield* buildPersonaContexts(repo, options.machine));

    // Each persona's login: its name, or the implicit one's token's.
    const logins: Array<string> = [];

    for (const own of repo.personas) {
      logins.push(
        yield* Option.match(own.persona, {
          onNone: () => viewerLoginAs(IMPLICIT),
          onSome: Effect.succeed,
        }),
      );
    }

    const context = yield* yield* Effect.fromOption(servicesFor(defaultPersona(repo))).pipe(
      Effect.orDie,
    );

    const findings = yield* backfill.value.survey(logins).pipe(
      Effect.provideContext(context),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BackfillFinding))),
      Effect.mapError((error) => {
        if (Schema.isSchemaError(error)) {
          return unreadable("findings")(error);
        }

        return new ConfigError({ message: error.message });
      }),
    );

    const result: BackfillResult = { repo: repo.settings.name, findings, written: [], lost: [] };

    if (!options.write) {
      return result;
    }

    // Each record announces itself as a run's does (announcePhases), so a CI
    // flow that reads it plans for it now rather than at the next sweep.
    const outcomes = yield* backfill.value.apply(findings).pipe(
      Effect.provideContext(context),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BackfillWritten))),
      Effect.mapError((error) => {
        if (Schema.isSchemaError(error)) {
          return unreadable("what it wrote")(error);
        }

        return new ConfigError({ message: error.message });
      }),
    );

    return {
      ...result,
      written: outcomes.filter((one) => one.written).map((one) => one.finding.item),
      lost: outcomes.filter((one) => !one.written).map((one) => one.finding.item),
    };
  });
