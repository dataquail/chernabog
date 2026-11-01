// The buttons that act on runs: a flow's run now, cancel on a run in flight
// (after a confirmation in the page), and attach (copy the command, or open
// the session in its launcher). Each shows the daemon's refusal beside it.

import type * as Option from "effect/Option";

import type { RepoStatus } from "#daemon/protocol";

import type { Outcome } from "./actions.ts";

// What a person has filled in of a flow's run now.
export type Draft = {
  readonly flow: string;
  readonly persona: Option.Option<string>;
  readonly item: string;
};

export const RunNowForm = (_props: {
  readonly repo: RepoStatus;
  readonly draft: Draft;
  readonly pending: boolean;
  readonly outcome: Option.Option<Outcome>;
  readonly onDraft: (draft: Draft) => void;
  readonly onSubmit: () => void;
}) => <></>;

export const CancelControl = (_props: {
  readonly label: string;
  readonly confirming: boolean;
  readonly closeSessions: boolean;
  readonly pending: boolean;
  readonly outcome: Option.Option<Outcome>;
  readonly onAsk: () => void;
  readonly onCloseSessions: (close: boolean) => void;
  readonly onConfirm: () => void;
  readonly onKeep: () => void;
}) => <></>;

export const AttachControl = (_props: {
  readonly opens: boolean;
  readonly pending: boolean;
  readonly outcome: Option.Option<Outcome>;
  readonly onCopy: () => void;
  readonly onOpen: () => void;
}) => <></>;
