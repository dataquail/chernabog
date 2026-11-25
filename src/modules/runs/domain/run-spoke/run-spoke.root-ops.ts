// The rules a spoke's record keeps: its fold position only moves on, and the
// first ending the hub means for it is the one it keeps.

import * as Option from "effect/Option";

import { RunSpokeRoot } from "./run-spoke.root.ts";
import { type SpokeEndRequest } from "./spoke-end-request.value-object.ts";

// The record once the hub has folded the report at `seq`: a position behind
// the one it holds changes nothing.
const advance = (spoke: RunSpokeRoot, seq: number) =>
  RunSpokeRoot.make({ ...spoke, foldedSeq: Math.max(spoke.foldedSeq, seq) });

// The record once the hub means `request` for it: one meant already holds,
// as whichever asked first ends the spoke.
const intend = (spoke: RunSpokeRoot, request: SpokeEndRequest) =>
  RunSpokeRoot.make({
    ...spoke,
    ending: Option.orElse(spoke.ending, () => Option.some(request)),
  });

export const RunSpokeRootOps = { advance, intend };
