// Registers the ledger's check with the Progress fake every flow's test runs
// on (ADR 21, decision 5), so the whole suite, every recipe and document a
// test runs, shows the catalogue declares every transition they really make:
// a transition it doesn't declare fails the test. A test names its runs as it
// likes, so a writer that isn't an observer is taken for a run here; the
// check of writers has tests of its own (test/ledger.test.ts).

import { Ledger } from "@chernabog/sdk";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { checkTransitionsWith } from "./progress-fake.ts";

export const registerLedgerCheck = () => {
  checkTransitionsWith((item, record) => {
    const asRun = Arr.filter([record.by], (by) => !by.startsWith("observer:"));

    return Option.map(Ledger.anomalyIn(asRun, item, record), Ledger.heldFor);
  });
};

registerLedgerCheck();
