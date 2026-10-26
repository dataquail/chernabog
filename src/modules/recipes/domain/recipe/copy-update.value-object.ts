// What updating does to one copied file, from the repo's copy, the
// recipe's file at the version it moves to, and what's recorded of where the
// copy came from.

import * as Option from "effect/Option";

import { type CopiedRecord } from "./repo-manifest.value-object.ts";

// What to do with a copied file nothing records the version of: keep it,
// recording it as from the version installed (its differences become the
// repo's own edits), or replace it with the recipe, as moving to a new SDK
// does.
export type Unrecorded = "adopt" | "replace";

export type CopyUpdate =
  // Nothing to do: already the recipe's file, recorded as such.
  | "unchanged"
  // The same as the recipe's file; only its record moves.
  | "record"
  // The repo hasn't the file: a file the recipe gained.
  | "written"
  // Nothing recorded: kept as it is, or replaced.
  | "adopted"
  | "replaced"
  // Recorded, and the recipe changed it since: merge from the version recorded.
  | "merge";

export const planCopyUpdate = (copy: {
  readonly ours: Option.Option<string>;
  readonly theirs: string;
  readonly record: Option.Option<CopiedRecord>;
  readonly target: CopiedRecord;
  readonly unrecorded: Unrecorded;
}): CopyUpdate => {
  if (Option.isNone(copy.ours)) {
    return "written";
  }

  const recorded = Option.exists(
    copy.record,
    (found) => found.from === copy.target.from && found.version === copy.target.version,
  );

  if (recorded) {
    return "unchanged";
  }

  if (copy.ours.value === copy.theirs) {
    return "record";
  }

  if (Option.isSome(copy.record)) {
    return "merge";
  }

  if (copy.unrecorded === "adopt") {
    return "adopted";
  }

  return "replaced";
};
