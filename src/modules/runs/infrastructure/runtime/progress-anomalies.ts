// `chernabog progress anomalies` (ADR 21, decision 5): the repo's own SDK's
// Ledger, run as the repo's first persona, over what every persona's login
// says is a writer of the repo's own. It lists every record a source would
// hold its item for, a writer or a transition the catalogue doesn't know;
// with `acknowledge`, it records the phase of each record a person saw listed
// again, by a writer the check knows, so the sources act on it, only while
// the item's record is still the version they saw. Records written before the check
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
  // The records to acknowledge, as the person saw them listed: each item and
  // its version, or the start of it as the listing prints it. None: only list.
  readonly acknowledge: ReadonlyArray<Seen>;
};

// A record as a person saw it listed: its item, and its version, or the start
// of it.
export type Seen = { readonly item: string; readonly version: string };

const SEEN = /^([^@\s]+)@([0-9A-Za-z]+)$/;

// `pr-184@9bf23c1`, as `--acknowledge` takes a record the listing named.
export const parseSeen = (text: string): Option.Option<Seen> =>
  Option.flatMap(Option.fromNullOr(SEEN.exec(text.trim())), ([, item, version]) =>
    Option.all({ item: Option.fromUndefinedOr(item), version: Option.fromUndefinedOr(version) }),
  );

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
  // With `acknowledge`: the records recorded again, and those whose item's
  // record is no longer the version the person saw, which are left alone.
  readonly acknowledged: ReadonlyArray<Seen>;
  readonly moved: ReadonlyArray<Seen>;
};

const isSeen = (seen: Seen) => (anomaly: Anomaly) =>
  anomaly.item === seen.item && anomaly.version.startsWith(seen.version);

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

    if (options.acknowledge.length === 0) {
      return result;
    }

    // Only a record still listed at the version the person saw; the advance
    // compares and sets on that version, so one that changes before the
    // write is left too.
    const still = anomalies.filter((anomaly) =>
      options.acknowledge.some((seen) => isSeen(seen)(anomaly)),
    );

    const outcomes = yield* ledger.value
      .acknowledge(still)
      .pipe(
        Effect.provideContext(context),
        decodedAs(Schema.Array(Acknowledged), "what it acknowledged"),
      );

    const landed = (seen: Seen) =>
      outcomes.some(
        (one) =>
          one.acknowledged &&
          still.some((anomaly) => anomaly.item === one.anomaly.item && isSeen(seen)(anomaly)),
      );

    return {
      ...result,
      acknowledged: options.acknowledge.filter(landed),
      moved: options.acknowledge.filter((seen) => !landed(seen)),
    };
  });
