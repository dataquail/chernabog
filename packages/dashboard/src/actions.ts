// What a person does to runs from the page: start a flow's run now, cancel a
// run in flight, open a run's session in its launcher. Each is a POST to the
// daemon that served the page, with the body the CLI sends; the daemon's
// Refusal, when it refuses, is what the page shows beside the button.

import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Option from "effect/Option";

export type Action =
  | {
      readonly kind: "run";
      readonly repo: string;
      readonly flow: string;
      readonly item: Option.Option<string>;
      readonly persona: Option.Option<string>;
    }
  | { readonly kind: "cancel"; readonly runId: string; readonly closeSessions: boolean }
  | { readonly kind: "attach"; readonly runId: string };

// How an action came out: what the daemon did, or why it wouldn't.
export type Outcome =
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

// The path an action posts to, under the page's origin, and its JSON body.
export type ActionRequest = { readonly path: string; readonly body: unknown };

export const requestFor = (_action: Action): ActionRequest => ({
  path: "",
  body: {},
});

// Posts an action to the daemon at `origin`; never fails: a refusal is an outcome.
export const perform = (
  _origin: string,
  _action: Action,
): Effect.Effect<Outcome, never, HttpClient.HttpClient> =>
  Effect.succeed({ kind: "refused", message: "" });

// What a person pastes into a terminal to attach to a run's session.
export const attachLine = (_runId: string) => "";
