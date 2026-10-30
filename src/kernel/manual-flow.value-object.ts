// A manual flow has no trigger, so nothing finds its work: it runs only when a
// person names an item. How a person starts one, for the messages that say so,
// and which flow `chernabog start <issue>` runs: the one that declares itself
// its entry point (defineFlow({ start: true })).

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

// A flow as `chernabog start` weighs it: its name, and whether it declares
// itself start's entry point.
export type StartCandidate = { readonly name: string; readonly start: boolean };

// The flow `chernabog start` runs in `repo`: the one that declares itself the
// entry point. Why there is none to run, when none or several do.
export const startFlowOf = (
  repo: string,
  flows: ReadonlyArray<StartCandidate>,
): Result.Result<string, string> => {
  const entries = Arr.dedupe(
    flows.flatMap((flow) => Option.toArray(Option.liftPredicate(flow.name, () => flow.start))),
  );

  if (entries.length === 1) {
    return Result.succeed(entries[0] ?? "");
  }

  if (entries.length === 0) {
    return Result.fail(
      `${repo} has no flow that chernabog start runs: none of its flows declares defineFlow({ start: true }). Add a recipe that does, or declare it on one of your own`,
    );
  }

  return Result.fail(
    `${repo} has several flows that chernabog start could run (${entries.join(", ")}): each declares defineFlow({ start: true }); keep it on one`,
  );
};

export const howToStart = (flow: string, start: boolean) => {
  if (start) {
    return "chernabog start <issue>";
  }

  return `chernabog run ${flow} --item <key>`;
};

// Why a manual flow started nothing when no one named its work.
export const nothingNamed = (flow: string, start: boolean) =>
  `${flow} is a manual flow: it runs only when someone names the work, so use ${howToStart(flow, start)}`;

// What status shows for a manual flow in place of its schedule.
export const manualSchedule = (flow: string, start: boolean) =>
  `manual (${howToStart(flow, start)})`;
