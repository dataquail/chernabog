import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";

import { RunId } from "../../../../kernel/run-id.id.ts";
import { Criteria, Spec } from "../../../../kernel/specification.ts";
import { RunRoot, type RunStatus } from "./run.root.ts";
import { RunSpecifications } from "./run.specification.ts";

const run = (id: string, repo: string, status: RunStatus) =>
  RunRoot.make({
    id: RunId.make(id),
    coreVersion: "0.6.0",
    repo,
    persona: Option.none(),
    flow: "review",
    itemKey: "pr-1",
    itemTitle: Option.none(),
    itemUrl: Option.none(),
    item: Option.none(),
    executionId: Option.none(),
    status,
    currentStep: Option.none(),
    summary: Option.none(),
    startedAt: "2026-10-20T00:00:00Z",
    finishedAt: Option.none(),
  });

const runs = [run("a", "demo", "running"), run("b", "demo", "done"), run("c", "other", "running")];

const ids = (spec: (candidate: RunRoot) => boolean) =>
  runs.flatMap((each) => Option.toArray(Option.liftPredicate(String(each.id), () => spec(each))));

describe("RunSpecifications", () => {
  test("all holds of every run, and withId of one", () => {
    expect(ids(RunSpecifications.all)).toEqual(["a", "b", "c"]);
    expect(ids(RunSpecifications.withId(RunId.make("b")))).toEqual(["b"]);
    expect(RunSpecifications.withId(RunId.make("b")).criteria).toEqual(
      Criteria.Eq({ field: "id", value: "b" }),
    );
  });

  test("running and forRepo compose into one repo's runs in flight", () => {
    expect(ids(RunSpecifications.running)).toEqual(["a", "c"]);
    expect(ids(RunSpecifications.forRepo("demo"))).toEqual(["a", "b"]);
    expect(ids(Spec.and(RunSpecifications.running, RunSpecifications.forRepo("demo")))).toEqual([
      "a",
    ]);
    expect(RunSpecifications.running.criteria).toEqual(
      Criteria.Eq({ field: "status", value: "running" }),
    );
  });
});
