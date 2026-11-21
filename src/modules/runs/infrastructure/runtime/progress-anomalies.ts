// `chernabog progress anomalies` (ADR 21, decision 5): the repo's own SDK's
// Ledger, run as the repo's first persona, over what every persona's login
// says is a writer of the repo's own. It lists every record a source would
// hold its item for, a writer or a transition the catalogue doesn't know;
// with `acknowledge`, it records each one's phase again, by a writer the
// check knows, so the sources act on it. Records written before the check
// are found here first, all at once, rather than one item at a time. The
// binary never imports the SDK (ADR 4): it loads the repo's, as backfill does.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ConfigError } from "../../../../platform/config-error.ts";
import { loadRepoLedger } from "../../../../platform/flow-loader.ts";
import { defaultPersona } from "./engine.ts";
import { buildPersonaContexts, openRepo, servicesFrom } from "./repo-runtime.ts";

type MachineConfig = Parameters<typeof openRepo>[0];

type EnrolledRepo = Parameters<typeof openRepo>[1];

export type AnomaliesOptions = {
  readonly machine: MachineConfig;
  readonly enrolled: EnrolledRepo;
  // The working copy's .chernabog/, rather than the default branch's.
  readonly fromCheckout: boolean;
  // Acknowledge what the survey found; without it, only list it.
  readonly acknowledge: boolean;
};

// One record the SDK's check fails, named as a source holding its item names it.
const Anomaly = Schema.Struct({
  item: Schema.String,
  phase: Schema.String,
  from: Schema.optionalKey(Schema.String),
  by: Schema.String,
  version: Schema.String,
  why: Schema.String,
});

export type Anomaly = typeof Anomaly.Type;

// What acknowledging one did: recorded again, or left for a record that moved since.
const Acknowledged = Schema.Struct({
  anomaly: Schema.Struct({ item: Schema.String }),
  acknowledged: Schema.Boolean,
});

export type AnomaliesResult = {
  readonly repo: string;
  // The repo's personas: (RepoSettings.personas). With none, every record a
  // persona wrote has an unknown writer, so each is an anomaly.
  readonly personas: ReadonlyArray<string>;
  readonly anomalies: ReadonlyArray<Anomaly>;
  // With `acknowledge`: the items recorded again, and those whose record moved first.
  readonly acknowledged: ReadonlyArray<string>;
  readonly moved: ReadonlyArray<string>;
};

const unreadable = (what: string) => (issue: { readonly message: string }) =>
  new ConfigError({
    message: `the repo's @chernabog/sdk gave ${what} this can't read: ${issue.message}`,
  });

const decodedAs =
  <A>(schema: Schema.Codec<A, unknown>, what: string) =>
  <E extends { readonly message: string }, R>(effect: Effect.Effect<unknown, E, R>) =>
    effect.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError((error) => {
        if (Schema.isSchemaError(error)) {
          return unreadable(what)(error);
        }

        return new ConfigError({ message: error.message });
      }),
    );

export const progressAnomalies = (options: AnomaliesOptions) =>
  Effect.gen(function* () {
    const { repo } = yield* openRepo(options.machine, options.enrolled, options.fromCheckout);
    const ledger = yield* loadRepoLedger(repo.settings.configDir);

    if (Option.isNone(ledger)) {
      return yield* new ConfigError({
        message: `${repo.settings.name}'s @chernabog/sdk is from before sources checked the records they read; chernabog recipes upgrade moves it on`,
      });
    }

    const servicesFor = servicesFrom(yield* buildPersonaContexts(repo, options.machine));

    const context = yield* yield* Effect.fromOption(servicesFor(defaultPersona(repo))).pipe(
      Effect.orDie,
    );

    const anomalies = yield* ledger.value.survey.pipe(
      Effect.provideContext(context),
      decodedAs(Schema.Array(Anomaly), "anomalies"),
    );

    const result: AnomaliesResult = {
      repo: repo.settings.name,
      personas: repo.settings.personas,
      anomalies,
      acknowledged: [],
      moved: [],
    };

    if (!options.acknowledge || anomalies.length === 0) {
      return result;
    }

    const outcomes = yield* ledger.value
      .acknowledge(anomalies)
      .pipe(
        Effect.provideContext(context),
        decodedAs(Schema.Array(Acknowledged), "what it acknowledged"),
      );

    return {
      ...result,
      acknowledged: outcomes.filter((one) => one.acknowledged).map((one) => one.anomaly.item),
      moved: outcomes.filter((one) => !one.acknowledged).map((one) => one.anomaly.item),
    };
  });
