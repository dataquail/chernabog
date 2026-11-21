// The ledger's tamper evidence (ADR 21, decision 5): the check every source's
// reads go through (ledger-check.ts), the catalogue it goes by
// (Blocks.transitions), and `chernabog progress anomalies`, which lists the
// records that fail it and, with a person's say-so, acknowledges them.
//
// A record written before the check, by a writer or a transition the
// catalogue doesn't know, holds its item like any other anomaly would. The
// survey lists them all at once, so a person upgrading sees them before a
// source holds them one by one, and acknowledges the ones that are right.

import {
  type Json,
  Phase as CorePhase,
  PhaseData,
  type PhaseRecord,
  PhaseWriter,
  Progress,
} from "@chernabog/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

import { transitions } from "./blocks.ts";
import { ACKNOWLEDGED, type Anomaly, check } from "./ledger-check.ts";

export * from "./ledger-check.ts";

// The catalogue the check goes by: every SDK block's and source's declarations.
export const catalogue = transitions;

// Whether `record`, the record of `item`, is an anomaly to `personas`, the
// repo's logins: why, or none when it passes.
export const anomalyIn = (personas: ReadonlyArray<string>, item: string, record: PhaseRecord) =>
  check(catalogue, personas)(item, record);

// Every record that fails the check, as the repo's personas, `logins`, see
// it. Plain JSON, as the binary reads it from the repo's SDK
// (loadRepoLedger) and hands it back to `acknowledge`.
export const survey = (logins: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const all = yield* Progress.use((progress) => progress.readAll);
    const judge = check(catalogue, logins);
    const found: Array<Anomaly> = [];

    for (const [item, record] of all) {
      for (const anomaly of Option.toArray(judge(item, record))) {
        found.push(anomaly);
      }
    }

    return Arr.sort(
      found,
      Order.mapInput(Order.String, (anomaly: Anomaly) => anomaly.item),
    );
  });

// What acknowledging one anomaly did: recorded again, or left, because its
// record moved since the survey read it.
export type Acknowledged = {
  readonly anomaly: Anomaly;
  readonly acknowledged: boolean;
};

const asPhase = Schema.decodeSync(CorePhase);
const asData = Schema.decodeSync(PhaseData);
const acknowledger = Schema.decodeSync(PhaseWriter)(ACKNOWLEDGED);

// Records each anomaly's phase again, with its data, by a writer the check
// knows (ACKNOWLEDGED): the person's say-so that the record is right, which
// the next tick's sources then act on. Only while the item still holds the
// record the survey found; one that moved since is left, since the record a
// person looked at is gone.
export const acknowledge = (anomalies: ReadonlyArray<Anomaly>) =>
  Effect.gen(function* () {
    const progress = yield* Progress;
    const results: Array<Acknowledged> = [];

    for (const anomaly of anomalies) {
      const current = yield* progress.read(anomaly.item);

      const still = Option.filter(current, (record) => record.version === anomaly.version);

      if (Option.isNone(still)) {
        results.push({ anomaly, acknowledged: false });

        continue;
      }

      const record = still.value;
      const phase = asPhase(record.phase);

      const base = {
        from: Option.some(phase),
        to: phase,
        by: acknowledger,
      };

      const transition = Option.match(record.data, {
        onNone: () => base,
        onSome: (data: { readonly [key: string]: Json }) => ({ ...base, data: asData(data) }),
      });

      const written = yield* progress.advance(anomaly.item, transition).pipe(
        Effect.as(true),
        Effect.catchTag("PhaseMoved", () => Effect.succeed(false)),
      );

      results.push({ anomaly, acknowledged: written });
    }

    return results;
  });
