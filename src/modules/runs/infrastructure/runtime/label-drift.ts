// `chernabog doctor`'s check of the status labels (ADR 21, decision 8): the
// repo's own SDK's Ledger.labelDrift, run as the repo's first persona, lists
// every open item whose status labels differ from what its record and claim
// project, such as a label a person edited by hand. The projector puts them
// right on the item's next advance or claim change, and nothing reads them,
// so this only says so. The binary never imports the SDK (ADR 4): it loads
// the repo's, as anomalies does.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { loadRepoLedger } from "../../../../platform/flow-loader.ts";
import { defaultPersona } from "./engine.ts";
import { buildPersonaContexts, servicesFrom } from "./repo-runtime.ts";

type EffectiveRepo = Parameters<typeof buildPersonaContexts>[0];

type MachineConfig = Parameters<typeof buildPersonaContexts>[1];

// One open item whose status labels differ from its projection: the labels
// it is missing, and those it has that the projection doesn't.
export const LabelDrift = Schema.Struct({
  item: Schema.String,
  number: Schema.Finite,
  missing: Schema.Array(Schema.String),
  extra: Schema.Array(Schema.String),
});

export type LabelDrift = typeof LabelDrift.Type;

// What the check found: the drifted items, or none when the repo's SDK has no
// projector to compare with, being from before it.
export const labelDrift = (repo: EffectiveRepo, machine: MachineConfig) =>
  Effect.gen(function* () {
    const ledger = yield* loadRepoLedger(repo.settings.configDir);
    const drift = Option.flatMap(ledger, (found) => Option.fromUndefinedOr(found.labelDrift));

    if (Option.isNone(drift)) {
      return Option.none<ReadonlyArray<LabelDrift>>();
    }

    const servicesFor = servicesFrom(yield* buildPersonaContexts(repo, machine));

    const context = yield* yield* Effect.fromOption(servicesFor(defaultPersona(repo))).pipe(
      Effect.orDie,
    );

    const found = yield* drift.value.pipe(Effect.provideContext(context));

    return Option.some(yield* Schema.decodeUnknownEffect(Schema.Array(LabelDrift))(found));
  });
