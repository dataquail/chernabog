// lint:architecture's rule that no source reads the world back as a record
// (scripts/world-reads.ts, ADR 21): it fires on each kind of read, leaves the
// linking markers, intent labels and writes alone, keeps to its exemptions,
// and finds nothing in the tree as it is.

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { inScope, treeReads, worldReads } from "../scripts/world-reads.ts";
import { effect } from "./effect-test.ts";

const SOURCE = "packages/sdk/src/some-block.ts";
const RECIPE = "packages/recipes/flows/some-flow.ts";

const readsIn = (source: string, file = SOURCE) =>
  worldReads(file, source).map((found) => found.text);

describe("a read of the world back as a record", () => {
  test.each([
    ["a status label tested on a pull request", "pull.labels.includes(labelNames.needsHuman)"],
    ["a status label's constant", "labels.includes(AWAITING_READY_LABEL)"],
    ["the projector's own constant", "pull.labels.includes(StatusLabels.ADOPTED)"],
    ["a status label by name", 'issue.labels.indexOf("auto:in-progress")'],
    ["the plan's proposed label", "issue.labels.includes(PLAN_LABELS.proposed)"],
    ["the items listed by a status label", "github.issuesLabelled(named.inProgress)"],
    ["a label compared with one", "labels.some((label) => label === labels.readyForPerson)"],
    ["a progress marker's read", "sessionMarker.read(comment.body)"],
    ["a progress marker's read passed on", "latestMarker(claimMarker.read, bodies)"],
  ])("fires on %s", (_, source) => {
    expect(readsIn(`export const found = ${source};`)).not.toEqual([]);
  });

  test("fires in a recipe too, at the read's line", () => {
    const found = worldReads(RECIPE, "const a = 1;\nconst b = reviewMarker.read(body);\n");

    expect(found.map((one) => [one.line, one.text])).toEqual([[2, "reviewMarker.read"]]);
  });

  test.each([
    ["a plan task's link", "planNodeMarker.read(issue.body)"],
    ["a follow-up's link", "Option.flatMap(issue.body, followUpMarker.read)"],
    ["the epic status comment's own marker", "statusMarker.read(comment.body)"],
    ["an intent label", "pull.labels.includes(labels.eligible)"],
    ["the plan's approved label, a person's intent", "issue.labels.includes(LABELS.approved)"],
    ["a status label written", "github.addLabel(number, labels.needsHuman)"],
    ["the record", "progress.read(item)"],
    ["settings", "Settings.read(Own)"],
    ["a phase compared", "found.phase === PHASES.pullRequest.approved"],
  ])("leaves alone %s", (_, source) => {
    expect(readsIn(`export const found = ${source};`)).toEqual([]);
  });

  test("backfill and the projector are exempt, and only the hand-back observer of phases.ts", () => {
    const read = "export const found = issue.labels.includes(labels.needsHuman);";

    expect(readsIn(read, "packages/sdk/src/backfill.ts")).toEqual([]);
    expect(readsIn(read, "packages/sdk/src/status-labels.ts")).toEqual([]);

    const observer =
      "export const handedBack = Effect.sync(() => open.includes(labels.needsHuman));";

    expect(readsIn(observer, "packages/sdk/src/phases.ts")).toEqual([]);
    expect(readsIn(read, "packages/sdk/src/phases.ts")).not.toEqual([]);
  });

  test("holds the SDK's sources and the recipes, not tests or installed packages", () => {
    expect(inScope("packages/sdk/src/implement.ts")).toBe(true);
    expect(inScope("packages/recipes/flows/implement.ts")).toBe(true);
    expect(inScope("packages/sdk/src/implement.test.ts")).toBe(false);
    expect(inScope("packages/recipes/node_modules/@chernabog/sdk/src/review.ts")).toBe(false);
    expect(inScope("packages/core/src/services.ts")).toBe(false);
    expect(inScope("src/interface/cli/main.ts")).toBe(false);
  });

  effect("finds none in the tree", () =>
    Effect.gen(function* () {
      expect(yield* treeReads()).toEqual([]);
    }),
  );
});
