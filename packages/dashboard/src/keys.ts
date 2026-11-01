// What a key does on the overview (stub).

import type * as Option from "effect/Option";

import { type DaemonStatus } from "#daemon/protocol";

export type KeyAction =
  | { readonly kind: "select"; readonly index: number }
  | { readonly kind: "open"; readonly runId: string }
  | { readonly kind: "focus-filter" }
  | { readonly kind: "none" };

export const runOrder = (_status: DaemonStatus): ReadonlyArray<string> => [];

export const onKey = (
  _key: string,
  _runs: ReadonlyArray<string>,
  _selected: Option.Option<number>,
): KeyAction => ({ kind: "none" });
